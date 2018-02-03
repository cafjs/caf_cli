'use strict';

var caf = require('caf_core');

exports.methods = {
    async __ca_init__() {
        this.state.counter = 42;
        this.$.session.limitQueue(1, 'default');
        return [];
    },
    async increment() {
        this.$.log && this.$.log.debug('Increment');
        this.state.counter = this.state.counter + 1;
        return [null, this.state.counter];
    },
    async decrement() {
        this.$.log && this.$.log.debug('Decrement');
        this.state.counter = this.state.counter - 1;
        return [null, this.state.counter];
    },
    async getCounter() {
        return [null, this.state.counter];
    }
};

caf.init(module);
