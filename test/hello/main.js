var caf_comp = require('caf_components');
var caf_ca = require('caf_ca');
var caf_platform = require('caf_platform');

exports.load = function($, spec, name, modules, cb) {
    modules = modules || [];
    modules.push(module);
    modules.push(caf_platform.getModule());
    modules.push(caf_ca.getModule());

    caf_comp.load($, spec, name, modules, cb);
};

