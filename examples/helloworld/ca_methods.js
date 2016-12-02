'use strict';

var caf = require('caf_core');

exports.methods = {
    __ca_init__: function(cb) {
        this.state.counter = 42;
        this.$.session.limitQueue(1, 'default');
        cb(null);
    },
    increment: function(cb) {
        this.$.log && this.$.log.debug('Increment');
        this.state.counter = this.state.counter + 1;
        cb(null, this.state.counter);
    },
    decrement: function(cb) {
        this.$.log && this.$.log.debug('Decrement');
        this.state.counter = this.state.counter - 1;
        cb(null, this.state.counter);
    },
    getCounter: function(cb) {
        cb(null, this.state.counter);
    }
};

caf.init(module);
