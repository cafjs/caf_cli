var cli = require('../../index.js');
var CA_NAME = process.env['CA_NAME'] || 'antonio-c2';
var WS_URL = process.env['WS_URL'] || 'ws://foo.vcap.me';
console.log('ca: '+ CA_NAME + ' ' + WS_URL);
var s = new cli.Session(WS_URL, CA_NAME);
var MAX_HELLOS = 100;

s.onclose = function(err) {
    console.log('Closing:' + JSON.stringify(err));
};
s.onmessage = function(msg) {
    console.log('message:' + JSON.stringify(msg));
};
s.onopen = function() {
    var count = 0;
    console.log('open session');
    var f = function() {
        s.hello('foo', function(err, data) {
                    if (err) {
                        console.log('Got error' + JSON.stringify(err));
                    } else {
                        console.log('Got data' + JSON.stringify(data));
                    }
                    count = count +1;
                    if (count < MAX_HELLOS) {
                        setTimeout(f, 1000);
                    } else {
                        s.close();
                    }
            });
    };
    f();
};
