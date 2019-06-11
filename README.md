# proxyratemanager

> ES6 JS classes for http/https Proxy Requests and IP rate limiting

## Installation

```sh
npm install proxyratemanager --save
```

## Usage

This is a module to facilitate proxying requests while staying within specified rate limits per action.  
  
NOTE: This module heavily relies on AdvancedRequest. Good understanding of it is pretty important to use this.  

Main features:
 - Automatically launch tor and change exit node  
 - Specification of multiple circuits through proxies or tor  
 - Automatic circuit "health" management to help avoid circuits during their downtime  
 - Specify actions to be limited by name per IP per unit time  
 - Specify pool of proxies to be randomly or specifically used  
  
Example setup
```js
const {ProxyRateManager, AdvancedProxiedRequest} = require('proxyratemanager');

let proxyRateManager = new ProxyRateManager({
  EXTERNAL_IP_CHECK_URL: `https://www.myexternalip.com/raw`,
});

let oneDayInMs = 1000 * 60 * 60 * 24;
proxyRateManager.addRateLimitActionKey({key: "apirequest1", limit: 1200, timeForRateReset: oneDayInMs});
proxyRateManager.addRateLimitActionKey({key: "apirequest2", limit: 1200, timeForRateReset: oneDayInMs});

await proxyRateManager.initWithCircuits([
  // named socks5h proxy
  {
    "name": "login_proxy", "port":7777,"username":"root","password":"pwpwpw","host":"example.com",
    addToCyclingCircuitPool: false, // (won't be included in pool)
  },

  // http proxy (will be in proxy pool)
  {"type": "http", "port":7777,"username":"root","password":"pwpwpw","host":"example2.com"},

  // isLocalTor being true for ANY circuit will trigger ProxyRateManager to start up tor
  // and manage it, killing it or sending signals to it to switch exit node IP addresses. 
  {"isLocalTor": true, "port":9050,"host":"3.3.3.3"},

  // unnamed socks5h proxies (in proxy pool)
  {"port":7777,"username":"root","password":"pwpwpw","host":"1.1.1.1"},
  {"port":7777,"username":"root","password":"pwpwpw","host":"2.2.2.2"},
  {"port":7777,"host":"3.3.3.3"}, // no un/pw
]);

// unnamed socks5h proxies (in proxy pool)
proxyRateManager.addCircuit({"port":7777,"username":"root","password":"pwpwpw","host":"4.4.4.4"});
```

Create a ProxyClient to send requests using the pool for this manager   
```javascript
let proxyClient = proxyRateManager.createClient();

// Send a request through this proxyClient
let req = new AdvancedProxiedRequest({
  url: `http://example.com/api/v1/dosomething`,
  method: 'GET',
  name: "apirequest1", // used to signal an action completed
  reqArgs: {
    proxyClient: proxyClient // specify this client to use
  },
});


// Call before running request on for this action name of "apirequest1"
await proxyClient.changeIPIfNecessary("apirequest1");

let jsonData = await req.runAsync(); // run the request (through the proxy)

if (jsonData.something_is_wrong_with_request_results) {
  // call .forceIPChangeImmediately() to have your exit IP randomly changed (guaranteed to change)
  await proxyClient.forceIPChangeImmediately();
} else {
  // report action completed for counters to update
  proxyClient.reportNewAction("apirequest1");
}
```
  
Get details about current circuit for this client object
```javascript
let exitIP = proxyClient.getCurrentIP(); // get the current external/exit IP from the client
let circuitIdentifier = proxyClient.circuit.getIdentifier(); // get the information its the circuit in use
let health = proxyClient.circuit.getHealth(); // All proxies are periodically polled to check their health/IPs

console.log(`[D] proxyClient details: exitIP=${exitIP} circuitIdentifier=${circuitIdentifier} health=${health}`);
```
  
A lot goes into this module. Reading the code is useful to understand more of how it works.  
  
## Credits
http://x64projects.tk/
