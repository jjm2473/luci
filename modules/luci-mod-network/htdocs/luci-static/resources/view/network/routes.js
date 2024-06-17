'use strict';
'require view';
'require fs';
'require form';
'require network';
'require tools.widgets as widgets';

return view.extend({
	load: function() {
		return Promise.all([
			network.getDevices(),
			fs.lines('/etc/iproute2/rt_tables')
		]);
	},

	render: function(data) {
		var netdevs = data[0],
		    m, s, o;

		var rtTables = data[1].map(function(l) {
			var m = l.trim().match(/^(\d+)\s+(\S+)$/);
			return m ? [ +m[1], m[2] ] : null;
		}).filter(function(e) {
			return e && e[0] > 0;
		});

		m = new form.Map('network', _('Routes'), _('Routes specify over which interface and gateway a certain host or network can be reached.'));
		m.tabbed = true;

		for (var i = 4; i <= 6; i += 2) {
			s = m.section(form.GridSection, (i == 4) ? 'route' : 'route6', (i == 4) ? _('Static IPv4 Routes') : _('Static IPv6 Routes'));
			s.anonymous = true;
			s.addremove = true;
			s.sortable = true;
			s.nodescriptions = true;

			s.tab('general', _('General Settings'));
			s.tab('advanced', _('Advanced Settings'));

			o = s.taboption('general', widgets.NetworkSelect, 'interface', _('Interface'));
			o.rmempty = false;
			o.nocreate = true;

			o = s.taboption('general', form.Flag, 'disabled', _('Disable'), _('Disable this route'));
			o.rmempty = true;
			o.default = o.disabled;

			o = s.taboption('general', form.Value, 'target', _('Target'), (i == 4) ? _('Host-<abbr title="Internet Protocol Address">IP</abbr> or Network') : _('<abbr title="Internet Protocol Version 6">IPv6</abbr>-Address or Network (CIDR)'));
			o.datatype = (i == 4) ? 'ip4addr' : 'ip6addr';
			o.rmempty = false;

			if (i == 4) {
				o = s.taboption('general', form.Value, 'netmask', _('<abbr title="Internet Protocol Version 4">IPv4</abbr>-Netmask'), _('if target is a network'));
				o.placeholder = '255.255.255.255';
				o.datatype = 'ip4addr';
				o.rmempty = true;
			}

			o = s.taboption('general', form.Value, 'gateway', (i == 4) ? _('<abbr title="Internet Protocol Version 4">IPv4</abbr>-Gateway') : _('<abbr title="Internet Protocol Version 6">IPv6</abbr>-Gateway'));
			o.datatype = (i == 4) ? 'ip4addr' : 'ip6addr';
			o.rmempty = true;

			o = s.taboption('advanced', form.Value, 'metric', _('Metric'));
			o.placeholder = 0;
			o.datatype = (i == 4) ? 'range(0,255)' : 'range(0,65535)';
			o.rmempty = true;
			o.textvalue = function(section_id) {
				return this.cfgvalue(section_id) || 0;
			};

			o = s.taboption('advanced', form.Value, 'mtu', _('MTU'));
			o.placeholder = 1500;
			o.datatype = 'range(64,9000)';
			o.rmempty = true;
			o.modalonly = true;

			o = s.taboption('advanced', form.ListValue, 'type', _('Route type'));
			o.value('', 'unicast');
			o.value('local');
			o.value('broadcast');
			o.value('multicast');
			o.value('unreachable');
			o.value('prohibit');
			o.value('blackhole');
			o.value('anycast');
			o.default = '';
			o.rmempty = true;
			o.modalonly = true;

			o = s.taboption('advanced', form.Value, 'table', _('Route table'));
			o.datatype = 'or(uinteger, string)';
			for (var j = 0; j < rtTables.length; j++)
				o.value(rtTables[j][1], '%s (%d)'.format(rtTables[j][1], rtTables[j][0]));
			o.textvalue = function(section_id) {
				return this.cfgvalue(section_id) || 'main';
			};

			o = s.taboption('advanced', form.Value, 'source', _('Source Address'));
			o.placeholder = E('em', _('automatic'));
			for (var j = 0; j < netdevs.length; j++) {
				var addrs = (i == 4) ? netdevs[j].getIPAddrs() : netdevs[j].getIP6Addrs();
				for (var k = 0; k < addrs.length; k++)
					o.value(addrs[k].split('/')[0]);
			}
			o.datatype = (i == 4) ? 'ip4addr' : 'ip6addr';
			o.default = '';
			o.rmempty = true;
			o.modalonly = true;

			o = s.taboption('advanced', form.Flag, 'onlink', _('On-Link route'));
			o.default = o.disabled;
			o.rmempty = true;
		}

		for (var family = 4; family <= 6; family += 2) {
			s = m.section(form.GridSection, (family == 6) ? 'rule6' : 'rule', (family == 6) ? _('IPv6 Rules') : _('IPv4 Rules'));
			s.anonymous = true;
			s.addremove = true;
			s.sortable = true;
			s.nodescriptions = true;

			s.tab('general', _('General Settings'));
			s.tab('advanced', _('Advanced Settings'));

			o = s.taboption('general', form.Value, 'priority', _('Priority'), _('Specifies the ordering of the IP rules'));
			o.datatype = 'uinteger';
			o.placeholder = 30000;
			o.textvalue = function(section_id) {
				return this.cfgvalue(section_id) || E('em', _('auto'));
			};

			o = s.taboption('general', form.ListValue, 'action', _('Rule type'), _('Specifies the rule target routing action'));
			o.modalonly = true;
			o.value('', 'unicast');
			o.value('unreachable');
			o.value('prohibit');
			o.value('blackhole');
			o.value('throw');

			o = s.taboption('general', widgets.NetworkSelect, 'in', _('Incoming interface'), _('Specifies the incoming logical interface name'));
			o.loopback = true;
			o.nocreate = true;

			o = s.taboption('general', form.Value, 'src', _('Source'), _('Specifies the source subnet to match (CIDR notation)'));
			o.datatype = (family == 6) ? 'cidr6' : 'cidr4';
			o.placeholder = (family == 6) ? '::/0' : '0.0.0.0/0';
			o.textvalue = function(section_id) {
				return this.cfgvalue(section_id) || E('em', _('any'));
			};

			o = s.taboption('general', widgets.NetworkSelect, 'out', _('Outgoing interface'), _('Specifies the outgoing logical interface name'));
			o.loopback = true;
			o.nocreate = true;

			o = s.taboption('general', form.Value, 'dest', _('Destination'), _('Specifies the destination subnet to match (CIDR notation)'));
			o.datatype = (family == 6) ? 'cidr6' : 'cidr4';
			o.placeholder = (family == 6) ? '::/0' : '0.0.0.0/0';
			o.textvalue = function(section_id) {
				return this.cfgvalue(section_id) || E('em', _('any'));
			};

			o = s.taboption('general', form.Value, 'lookup', _('Table'), _('The rule target is a table lookup ID: a numeric table index ranging from 0 to 65535 or symbol alias declared in /etc/iproute2/rt_tables. Special aliases local (255), main (254) and default (253) are also valid'));
			o.datatype = 'or(uinteger, string)';
			for (var i = 0; i < rtTables.length; i++)
				o.value(rtTables[i][1], '%s (%d)'.format(rtTables[i][1], rtTables[i][0]));

			o = s.taboption('advanced', form.Value, 'goto', _('Jump to rule'), _('The rule target is a jump to another rule specified by its priority value'));
			o.modalonly = true;
			o.datatype = 'uinteger';
			o.placeholder = 80000;

			o = s.taboption('advanced', form.Value, 'mark', _('Firewall mark'), _('Specifies the fwmark and optionally its mask to match, e.g. 0xFF to match mark 255 or 0x0/0x1 to match any even mark value'));
			o.modalonly = true;
			o.datatype = 'string';
			o.placeholder = '0x1/0xf';

			o = s.taboption('advanced', form.Value, 'tos', _('Type of service'), _('Specifies the TOS value to match in IP headers'));
			o.modalonly = true;
			o.datatype = 'uinteger';
			o.placeholder = 10;

			o = s.taboption('advanced', form.Value, 'suppress_prefixlength', _('Prefix suppressor'), _('Reject routing decisions that have a prefix length less than or equal to the specified value'));
			o.modalonly = true;
			o.datatype = (family == 6) ? 'ip6prefix' : 'ip4prefix';
			o.placeholder = (family == 6) ? 64 : 24;

			o = s.taboption('advanced', form.Flag, 'invert', _('Invert match'), _('If set, the meaning of the match options is inverted'));
			o.modalonly = true;
			o.default = o.disabled;

		}

		return m.render();
	}
});
