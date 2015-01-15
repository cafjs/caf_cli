var async = require('async');
var caf_comp = require('caf_components');
var myUtils = caf_comp.myUtils;
var cli = require('../index.js');
var hello = require('./hello/main.js');

var app = hello;

var HOST='localhost';
var PORT=3000;

module.exports = {
    setUp: function (cb) {
        var self = this;
        app.load(null, {name: 'top'}, 'framework.json', null,
                      function(err, $) {
                          if (err) {
                              console.log('setUP Error' + err);
                              // ignore errors here, check in method
                              cb(null);
                          } else {
                              self.$ = $;
                              cb(err, $);
                          }
                      });
    },
    tearDown: function (cb) {
        var self = this;
        if (!this.$) {
            cb(null);
        } else {
            this.$.top.__ca_shutdown__(null, cb);
        }
    },
    hello: function(test) {
        var self = this;
        test.expect(6);
        var s;
        async.waterfall([
                            function(cb) {
                                s = new cli.Session('ws://localhost:3000',
                                                    'antonio-c1');
                                test.throws(function() {
                                                s.helllllooo('foo',cb);
                                            }, Error, 'bad method name');
                                test.throws(function() {
                                                s.hello('foo','bar', cb);
                                            }, Error, 'bad # args');
                                test.throws(function() {
                                                s.hello('foo','bar');
                                            }, Error, 'no callback');
                                s.onopen = function() {
                                    s.hello('foo', cb);
                                };
                            },
                            function(res, cb) {
                                test.equals(res, 'Bye:foo');
                                s.onclose = function(err) {
                                    test.ok(!err);
                                    cb(null, null);
                                };
                                s.close();
                            }
                     ], function(err, res) {
                         test.ifError(err);

                         test.done();
                     });
    },
    helloFail: function(test) {
        var self = this;
        test.expect(5);
        var s;
        async.waterfall([
                            function(cb) {
                                s = new cli.Session('ws://localhost:3000',
                                                    'antonio-c1');
                                s.onopen = function() {
                                    var cb0 = function(err, val) {
                                        test.ok(err);
                                        test.ok(err.stack);
                                        test.equals(err.msg,
                                                    'helloFail');
                                        cb(null, null);
                                    };
                                    s.helloFail('foo', cb0);
                                };
                            },
                            function(res, cb) {
                                s.onclose = function(err) {
                                    test.ok(!err);
                                    cb(null, null);
                                };
                                s.close();
                            }
                        ], function(err, res) {
                            test.ifError(err);
                            test.done();
                        });
    }

};
