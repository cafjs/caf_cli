var cli = require('../../index.js');
var s = new cli.Session('ws://localhost:3000', 'antonio-c2');
s.onclose = function(err) {
    console.log('Closing:' + JSON.stringify(err));
};
s.onmessage = function(msg) {
    console.log('message:' + JSON.stringify(msg));
};
s.onopen = function() {
    console.log('open session');
    s.helloDelayException('foo', function(err, data) {
                if (err) {
                    console.log('Got error' + JSON.stringify(err));
                } else {
                    console.log('Got data' + JSON.stringify(data));
                }
                s.close();
            });

};
