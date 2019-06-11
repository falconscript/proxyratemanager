"use strict";


/**
 * ProxyCircuit
 * Structure for circuits
 */
class ProxyCircuit {
  constructor (args) {
    let circuitDefaults = {
      host: '0.0.0.0', 
      port: 9050, 
      username: null,
      password: null,
      type: "socks5h", // default socks5h. Other options: "http" and "https" (not socks5)
      poll_wait_interval: null, // in ms. default is 5s for tor, 2 minutes for proxy
      name: null, // can find circuit by name
      addToCyclingCircuitPool: true, // set to false to ONLY allow clients to use this circuit by name
      isLocalTor: false, // pass true to start up and manage tor

      activeExitNodeIP: null,
      lastIPPollTime: 0, // start with timestamp of 0, meaning 1970 I guess
      healInterval: 1000 * 60 * 20, // how often to add health (in ms)
      healAmountPerInterval: 10, // how much health to add every <healInterval> ms
    };

    // time between IP poll checks in ms. default is 5s for tor, 2 minutes for proxy
    this.poll_wait_interval = this.poll_wait_interval || (this.isLocalTor ?  1000 * 5 : 1000 * 60 * 2);

    this.health = 100; // estimation of reliability for circuit
    this.valid = true;
    this.pollingClient = null;

    // Store attributes onto this struct directly
    Object.assign(this, circuitDefaults, args); // override defaults with args

    // Start interval to heal (add default health) every so often to retest circuit later
    this.healIntFD = setInterval(() => this.promoteHealth(this.healAmountPerInterval), this.healInterval);
  }

  // Get the connection URL for a proxy - AND the circuit's specified name in front if applicable
  getIdentifier () {    
    let name = this.name ? `(${this.name}) ` : ""; 
    return name + this.getProxyIDString();
  }

  // Get the connection URL for a proxy
  getProxyIDString () {
    let unpw = (this.username || this.password) ? `${this.username || ''}:${this.password || ''}@` : "";

    return `${this.type}://${unpw}${this.host}:${this.port}`;
  }

  // Get object defining the socksAgents options for this circuit
  getSocksAgentOptions () {
    return {
      socksHost: this.host,
      socksPort: this.port, // Defaults to 1080. Set to tor port
      socksUsername: this.username,
      socksPassword: this.password,
    }
  }

  isValid () { return this.valid; }
  markInvalid () { this.valid = false; } // circuit cannot be marked valid. this means circuit dead

  setPollingClient (pollingClient) {
    this.pollingClient = pollingClient;
  }

  isHealthy () {
    return this.health > 20;
  }

  degradeHealth (degradation=10) {
    this.health = Math.max(0, this.health - degradation);
    DEBUG(`[D] ${this.constructor.name}.degradeHealth [${this.getIdentifier()}] - Lowering health to ${this.health}`);
  }

  promoteHealth (improvement=10) {
    this.health = Math.min(100, this.health + improvement);
    vDEBUG(`[D] ${this.constructor.name}.degradeHealth [${this.getIdentifier()}] - Increasing health to ${this.health}`);
  }

  getHealth () { return this.health; }
};


module.exports = ProxyCircuit;
