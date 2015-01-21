var cli = require('../../index.js');
var s = new cli.Session('ws://foo.vcap.me:4000', 'antonio-c2');
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
