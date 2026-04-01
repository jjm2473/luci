'use strict';
'require view';
'require poll';
'require request';
'require rpc';
'require fs';

var callLuciRealtimeStats = rpc.declare({
	object: 'luci',
	method: 'getRealtimeStats',
	params: [ 'mode', 'device' ],
	expect: { result: [] }
});

var callNetworkRrdnsLookup = rpc.declare({
	object: 'network.rrdns',
	method: 'lookup',
	params: [ 'addrs', 'timeout', 'limit' ],
	expect: { '': {} }
});

var graphPolls = [],
    pollInterval = 3,
    dns_cache = {},
    enableLookups = false,
    filterText = '';

var recheck_lookup_queue = {};

Math.log2 = Math.log2 || function(x) { return Math.log(x) * Math.LOG2E; };

/*
 * Convert an full IPv6 address string to a shortened format
 * Examples:
[
	compressIpv6('2620:01ec:0029:0001:0000:0000:0000:0049') === '2620:1ec:29:1::49',
	compressIpv6('fe80:0000:0000:0000:d86d:2fff:fe24:f6ea') === 'fe80::d86d:2fff:fe24:f6ea',
	compressIpv6('fe80:0000:0000:0000:d86d:2fff:0000:f6ea') === 'fe80::d86d:2fff:0:f6ea',
	compressIpv6('fe80:0100:0010:0001:d86d:2fff:0000:f6ea') === 'fe80:100:10:1:d86d:2fff::f6ea',
	compressIpv6('fe80:0000:d86d:2fff:0000:0000:0000:f6ea') === 'fe80:0:d86d:2fff::f6ea',
	compressIpv6('ff02:0000:0000:0000:0000:0000:0001:0002') === 'ff02::1:2',
	compressIpv6('0000:0000:0000:0000:0000:0000:0000:0001') === '::1',
	compressIpv6('0000:0000:0000:0000:0000:0000:0000:0000') === '::',
	compressIpv6('0001:0000:0000:0000:0000:0000:0000:0000') === '1::',
	compressIpv6('0000:0001:0001:0001:0001:0001:0001:0001') === '::1:1:1:1:1:1:1',
	compressIpv6('0001:0000:0001:0001:0001:0001:0001:0001') === '1::1:1:1:1:1:1',
	compressIpv6('0001:0001:0001:0001:0001:0001:0001:0001') === '1:1:1:1:1:1:1:1',
]
 */
var compressIpv6 = function(addr) {
	if (addr.indexOf(':') === -1)
		return addr;

	var parts = addr.split(':');
	var best_start = 0, best_len = 0, cur_start = 0, cur_len = 0;
	for (var i = 0; i < parts.length; i++) {
		if (parts[i].startsWith('0'))
			parts[i] = parts[i].replace(/^0+/, '').replace(/^$/, '0');

		if (parts[i] === '0') {
			if (cur_len === 0)
				cur_start = i;
			cur_len++;
		} else {
			if (cur_len > best_len) {
				best_start = cur_start;
				best_len = cur_len;
			}
			cur_len = 0;
		}
	}
	if (cur_len > best_len) {
		best_start = cur_start;
		best_len = cur_len;
	}
	if (best_len > 0) {
		parts.splice(best_start, best_len, '');
	}
	return (best_start===0&&best_len>0?':':'')+parts.join(':')+(best_start+best_len===8?':':'');
};

return view.extend({
	load: function() {
		return Promise.all([
			this.loadSVG(L.resource('svg/connections.svg')),
			fs.lines('/etc/protocols')
		]);
	},

	updateGraph: function(svg, lines, cb) {
		var G = svg.firstElementChild;

		var view = document.querySelector('#view');

		var width  = view.offsetWidth - 2;
		var height = 300 - 2;
		var step   = 5;

		var data_wanted = Math.floor(width / step);

		var data_values = [],
		    line_elements = [];

		for (var i = 0; i < lines.length; i++)
			if (lines[i] != null)
				data_values.push([]);

		var info = {
			line_current: [],
			line_average: [],
			line_peak:    []
		};

		/* prefill datasets */
		for (var i = 0; i < data_values.length; i++)
			for (var j = 0; j < data_wanted; j++)
					data_values[i][j] = 0;

		/* plot horizontal time interval lines */
		for (var i = width % (step * 60); i < width; i += step * 60) {
			var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
				line.setAttribute('x1', i);
				line.setAttribute('y1', 0);
				line.setAttribute('x2', i);
				line.setAttribute('y2', '100%');
				line.setAttribute('style', 'stroke:black;stroke-width:0.1');

			var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				text.setAttribute('x', i + 5);
				text.setAttribute('y', 15);
				text.setAttribute('style', 'fill:#eee; font-size:9pt; font-family:sans-serif; text-shadow:1px 1px 1px #000');
				text.appendChild(document.createTextNode(Math.round((width - i) / step / 60) + 'm'));

			G.appendChild(line);
			G.appendChild(text);
		}

		info.interval = pollInterval;
		info.timeframe = data_wanted / 60;

		graphPolls.push({
			svg:    svg,
			lines:  lines,
			cb:     cb,
			info:   info,
			width:  width,
			height: height,
			step:   step,
			values: data_values,
			timestamp: 0,
			fill: 1
		});
	},

	updateConntrack: function(conn) {
		var lookup_queue = [ ];
		var rows = [];

		conn.sort(function(a, b) {
			return b.bytes - a.bytes;
		});

		for (var i = 0; i < conn.length; i++)
		{
			var c  = conn[i];

			if ((c.src == '127.0.0.1' && c.dst == '127.0.0.1') ||
				(c.src == '::1'       && c.dst == '::1'))
				continue;

			if (!dns_cache[c.src] && lookup_queue.indexOf(c.src) == -1)
				lookup_queue.push(c.src);

			if (!dns_cache[c.dst] && lookup_queue.indexOf(c.dst) == -1)
				lookup_queue.push(c.dst);

			var src = dns_cache[c.src] || (c.layer3 == 'ipv6' ? '[' + c.src + ']' : c.src);
			var dst = dns_cache[c.dst] || (c.layer3 == 'ipv6' ? '[' + c.dst + ']' : c.dst);

			const network = c.layer3.toUpperCase();
			const protocol = c.layer4.toUpperCase();
			const source ='%h'.format(c.hasOwnProperty('sport') ? (src + ':' + c.sport) : src);
			const destination = '%h'.format(c.hasOwnProperty('dport') ? (dst + ':' + c.dport) : dst);
			const transfer = [ c.bytes, '%1024.2mB (%d %s)'.format(c.bytes, c.packets, _('Pkts.')) ];

			if (filterText) {
				let filterTextExpressions = filterText.split(' ');
				if (filterTextExpressions.some((element) => element.toUpperCase() !== network && element.toUpperCase() !== protocol 
						&& !(c.src.includes(element) || source.includes(element))
						&& !(c.dst.includes(element) || destination.includes(element)))) {
					continue;
				}
			}

			rows.push([
				network,
				protocol,
				source,
				destination,
				transfer,
			]);
		}

		cbi_update_table('#connections', rows, E('em', _('No information available')));

		if (enableLookups && lookup_queue.length > 0) {
			var reduced_lookup_queue = lookup_queue;

			if (lookup_queue.length > 100)
				reduced_lookup_queue = lookup_queue.slice(0, 100);

			callNetworkRrdnsLookup(reduced_lookup_queue, 5000, 1000).then(function(replies) {
				for (var index in reduced_lookup_queue) {
					var address = reduced_lookup_queue[index];

					if (!address)
						continue;

					if (replies[address]) {
						dns_cache[address] = replies[address];
						lookup_queue.splice(reduced_lookup_queue.indexOf(address), 1);
						continue;
					}

					if (recheck_lookup_queue[address] > 2) {
						dns_cache[address] = (address.match(/:/)) ? '[' + address + ']' : address;
						lookup_queue.splice(index, 1);
					}
					else {
						recheck_lookup_queue[address] = (recheck_lookup_queue[address] || 0) + 1;
					}
				}

				var btn = document.querySelector('.btn.toggle-lookups');
				if (btn) {
					btn.firstChild.data = enableLookups ? _('Disable DNS lookups') : _('Enable DNS lookups');
					btn.classList.remove('spinning');
					btn.disabled = false;
				}
			});
		}
	},

	/*
	 * Replace the conntrack ubus call with a direct read of /proc/net/nf_conntrack to prevent
	 *   procd from being kicked off by ubusd due to large amounts of data. See https://github.com/openwrt/openwrt/issues/9747
	 *
	 * Copy from modules/luci-base/ucode/sys.uc:conntrack_list with adjustments for js
	 */
	conntrackList: function() {
		var protos = this.protos;
		return fs.exec_direct('/bin/grep', ['-vF', 'TIME_WAIT', '/proc/net/nf_conntrack']).then(function(data){
			var connt = [];

			data.split('\n').forEach(function(line) {
				var m = line.match(/^(ipv[46]) +([0-9]+) +\S+ +([0-9]+)( +.+)$/);
				if (!m)
					return;

				var fam = m[1];
				var l4 = m[3];
				var tuples = m[4];
				var timeout = null;

				m = tuples.match(/^ +([0-9]+)( .+)$/);

				if (m) {
					timeout = m[1];
					tuples = m[2];
				}

				var e = {
					bytes: 0,
					packets: 0,
					layer3: fam,
					layer4: protos[l4] || 'unknown',
					timeout: +timeout
				};

				tuples.split(' ').forEach(function(tuple) {
					var kv = tuple.match(/^(\w+)=(\S+)$/);

					if (!kv)
						return;

					switch (kv[1]) {
					case 'bytes':
					case 'packets':
						e[kv[1]] += +kv[2];
						break;

					case 'src':
					case 'dst':
						if (undefined === e[kv[1]])
							e[kv[1]] = compressIpv6(kv[2]);
						break;

					case 'sport':
					case 'dport':
						if (undefined === e[kv[1]])
							e[kv[1]] = +kv[2];
						break;
					}
				});

				connt.push(e);
			});
			return connt;

		});
	},

	pollData: function() {
		poll.add(L.bind(function() {
			var tasks = [
				L.resolveDefault(this.conntrackList(), [])
			];

			for (var i = 0; i < graphPolls.length; i++) {
				var ctx = graphPolls[i];
				tasks.push(L.resolveDefault(callLuciRealtimeStats('conntrack'), []));
			}

			return Promise.all(tasks).then(L.bind(function(datasets) {
				this.updateConntrack(datasets[0]);

				for (var gi = 0; gi < graphPolls.length; gi++) {
					var ctx = graphPolls[gi],
					    data = datasets[gi + 1],
					    values = ctx.values,
					    lines = ctx.lines,
					    info = ctx.info;

					var data_scale = 0;
					var data_wanted = Math.floor(ctx.width / ctx.step);
					var last_timestamp = NaN;

					for (var i = 0, di = 0; di < lines.length; di++) {
						if (lines[di] == null)
							continue;

						var multiply = (lines[di].multiply != null) ? lines[di].multiply : 1,
						    offset = (lines[di].offset != null) ? lines[di].offset : 0;

						for (var j = ctx.timestamp ? 0 : 1; j < data.length; j++) {
							/* skip overlapping entries */
							if (data[j][0] <= ctx.timestamp)
								continue;

							if (i == 0) {
								ctx.fill++;
								last_timestamp = data[j][0];
							}

							info.line_current[i] = data[j][di + 1] * multiply;
							info.line_current[i] -= Math.min(info.line_current[i], offset);
							values[i].push(info.line_current[i]);
						}

						i++;
					}

					/* cut off outdated entries */
					ctx.fill = Math.min(ctx.fill, data_wanted);

					for (var i = 0; i < values.length; i++) {
						var len = values[i].length;
						values[i] = values[i].slice(len - data_wanted, len);

						/* find peaks, averages */
						info.line_peak[i] = NaN;
						info.line_average[i] = 0;

						for (var j = 0; j < values[i].length; j++) {
							info.line_peak[i] = isNaN(info.line_peak[i]) ? values[i][j] : Math.max(info.line_peak[i], values[i][j]);
							info.line_average[i] += values[i][j];
						}

						info.line_average[i] = info.line_average[i] / ctx.fill;
					}

					info.peak = Math.max.apply(Math, info.line_peak);

					/* remember current timestamp, calculate horizontal scale */
					if (!isNaN(last_timestamp))
						ctx.timestamp = last_timestamp;

					var size = Math.floor(Math.log2(info.peak)),
					    div = Math.pow(2, size - (size % 10)),
					    mult = info.peak / div,
					    mult = (mult < 5) ? 2 : ((mult < 50) ? 10 : ((mult < 500) ? 100 : 1000));

					info.peak = info.peak + (mult * div) - (info.peak % (mult * div));

					data_scale = ctx.height / info.peak;

					/* plot data */
					for (var i = 0, di = 0; di < lines.length; di++) {
						if (lines[di] == null)
							continue;

						var el = ctx.svg.firstElementChild.getElementById(lines[di].line),
						    pt = '0,' + ctx.height,
						    y = 0;

						if (!el)
							continue;

						for (var j = 0; j < values[i].length; j++) {
							var x = j * ctx.step;

							y = ctx.height - Math.floor(values[i][j] * data_scale);
							//y -= Math.floor(y % (1 / data_scale));

							y = isNaN(y) ? ctx.height : y;

							pt += ' ' + x + ',' + y;
						}

						pt += ' ' + ctx.width + ',' + y + ' ' + ctx.width + ',' + ctx.height;

						el.setAttribute('points', pt);

						i++;
					}

					info.label_25 = 0.25 * info.peak;
					info.label_50 = 0.50 * info.peak;
					info.label_75 = 0.75 * info.peak;

					if (typeof(ctx.cb) == 'function')
						ctx.cb(ctx.svg, info);
				}
			}, this));
		}, this), pollInterval);
	},

	loadSVG: function(src) {
		return request.get(src).then(function(response) {
			if (!response.ok)
				throw new Error(response.statusText);

			return E('div', {
				'style': 'width:100%;height:300px;border:1px solid #000;background:#fff'
			}, E(response.text()));
		});
	},

	render: function(data) {
		var svg = data[0];
		var protocols = data[1];
		var protos = {};
		protocols.forEach(function(line) {
			var m = line.match(/^([^# \t\n]+)\s+([0-9]+)\s+/);

			if (m)
				protos[m[2]] = m[1];
		});
		this.protos = protos;

		var v = E('div', { 'class': 'cbi-map', 'id': 'map' }, [
			E('h2', _('Connections')),
			E('div', {'class': 'cbi-map-descr'}, _('This page displays the active connections via this device.')),
			E('div', { 'class': 'cbi-section' }, [
				svg,
				E('div', { 'class': 'right' }, E('small', { 'id': 'scale' }, '-')),
				E('br'),

				E('table', { 'class': 'table', 'style': 'width:100%;table-layout:fixed' }, [
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid blue' }, [ _('UDP:') ])),
						E('td', { 'class': 'td', 'id': 'lb_udp_cur' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Average:') ])),
						E('td', { 'class': 'td', 'id': 'lb_udp_avg' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'lb_udp_peak' }, [ '0' ])
					]),
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid green' }, [ _('TCP:') ])),
						E('td', { 'class': 'td', 'id': 'lb_tcp_cur' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Average:') ])),
						E('td', { 'class': 'td', 'id': 'lb_tcp_avg' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'lb_tcp_peak' }, [ '0' ])
					]),
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid red' }, [ _('Other:') ])),
						E('td', { 'class': 'td', 'id': 'lb_otr_cur' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Average:') ])),
						E('td', { 'class': 'td', 'id': 'lb_otr_avg' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'lb_otr_peak' }, [ '0' ])
					])
				]),

				E('br'),

				E('div', { 
					id: 'settings-row',
					style: 'display: flex',
				}, [
					E('span', { 
						class: 'filter',
						style: 'flex: auto',
					}, [
						E('input', {
							id: 'filter-connections',
							type: 'text',
							placeholder: '192.168.1.15 / UDP 1.15 / :443',
							class: 'cbi-input-text',
							style: 'width: 100%',
							keyup: function(ev) {
								filterText = this.value;
						    }
						})
					]),
					E('span', { 
						class: 'right',
						style: 'flex: auto',
					}, [
						E('button', {
							'class': 'btn cbi-button cbi-button-apply toggle-lookups',
							'click': function(ev) {
								if (!enableLookups) {
									ev.currentTarget.classList.add('spinning');
									ev.currentTarget.disabled = true;
									enableLookups = true;
								}
								else {
									ev.currentTarget.firstChild.data = _('Enable DNS lookups');
									enableLookups = false;
								}

								this.blur();
							}
						}, [ enableLookups ? _('Disable DNS lookups') : _('Enable DNS lookups') ])
					]),
				]),

				E('br'),

				E('div', { 'class': 'cbi-section-node' }, [
					E('table', { 'class': 'table', 'id': 'connections' }, [
						E('tr', { 'class': 'tr table-titles' }, [
							E('th', { 'class': 'th col-2 hide-xs' }, [ _('Network') ]),
							E('th', { 'class': 'th col-2' }, [ _('Protocol') ]),
							E('th', { 'class': 'th col-7' }, [ _('Source') ]),
							E('th', { 'class': 'th col-7' }, [ _('Destination') ]),
							E('th', { 'class': 'th col-4' }, [ _('Transfer') ])
						]),
						E('tr', { 'class': 'tr placeholder' }, [
							E('td', { 'class': 'td' }, [
								E('em', {}, [ _('Collecting data...') ])
							])
						])
					])
				])
			])
		]);

		this.updateGraph(svg, [ { line: 'udp' }, { line: 'tcp' }, { line: 'other' } ], function(svg, info) {
			var G = svg.firstElementChild, tab = svg.parentNode;

			G.getElementById('label_25').firstChild.data = '%d'.format(info.label_25);
			G.getElementById('label_50').firstChild.data = '%d'.format(info.label_50);
			G.getElementById('label_75').firstChild.data = '%d'.format(info.label_75);

			tab.querySelector('#scale').firstChild.data = _('(%d minute window, %d second interval)').format(info.timeframe, info.interval);

			tab.querySelector('#lb_udp_cur').firstChild.data = '%d'.format(info.line_current[0]);
			tab.querySelector('#lb_udp_avg').firstChild.data = '%d'.format(info.line_average[0]);
			tab.querySelector('#lb_udp_peak').firstChild.data = '%d'.format(info.line_peak[0]);

			tab.querySelector('#lb_tcp_cur').firstChild.data = '%d'.format(info.line_current[1]);
			tab.querySelector('#lb_tcp_avg').firstChild.data = '%d'.format(info.line_average[1]);
			tab.querySelector('#lb_tcp_peak').firstChild.data = '%d'.format(info.line_peak[1]);

			tab.querySelector('#lb_otr_cur').firstChild.data = '%d'.format(info.line_current[2]);
			tab.querySelector('#lb_otr_avg').firstChild.data = '%d'.format(info.line_average[2]);
			tab.querySelector('#lb_otr_peak').firstChild.data = '%d'.format(info.line_peak[2]);
		});

		this.pollData();

		return v;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
