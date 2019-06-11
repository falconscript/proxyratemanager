"use strict";


/**
 * ProxyRateClient
 */
class ProxyRateClient {
  constructor (args) {
    this.clientId = args.clientId;
    this.manager = args.manager;
    this.circuit = args.circuit;
    this.isPollingClient = args.isPollingClient || false;

    this.clientName = args.clientName || `Client #${this.clientId}`;
  }

  getSocksAgentOptions () {
    return this.circuit.getSocksAgentOptions();
  }

  getCurrentIP () {
    return this.circuit.activeExitNodeIP;
  }

  _changeToRandomCircuit () {
    if (this.isPollingClient) { // Polling clients cannot change circuit
      return;
    }

    this.circuit = this.manager._getRandomCircuit(this.circuit); // providing circuitId to ensure it is omitted in options
  }

  /**
   * call .forceIPChangeImmediately() to have your route randomly changed (guaranteed to change)
   * change happens instantly. may cause minor trouble with stats, but not generally
   */
  async forceIPChangeImmediately () {
    if (this.circuit.isLocalTor) {
      return await this.manager.forceIPChangeImmediately();
    } else if (!this.circuit.addToCyclingCircuitPool) {
      INFO(
        `[-] ProxyRateClient.forceIPChangeImmediately - [${this.clientName}] is using rigid circuit` +
        ` [${this.circuit.getIdentifier()}] outside of pool and cannot change. Continuing as normal.`
      );
    } else {
      return this._changeToRandomCircuit();
    }
  }

  async changeIPIfNecessary (actionName) {
    if (!this.circuit.addToCyclingCircuitPool) {
      DIE(
        `[-] ProxyRateClient.changeIPIfNecessary - [${this.clientName}] is using rigid circuit`
        + ` [${this.circuit.getIdentifier()}] outside of pool and cannot change. Should never call this!!`
      );
    }

    if (this.manager._isIPAvailableForRequests(this.circuit.activeExitNodeIP, actionName)) {
      return false;
    } else {
      // NOTE: this below actually *double checks* unnecessarily. whatever
      //return await this.manager.changeIPIfNecessary(this.circuit, actionName);

      // propagate properly
      return await this.forceIPChangeImmediately();
    }
  }

  reportNewAction (action) {
    if (!this.circuit.addToCyclingCircuitPool) {
      DIE(
        `[-] ProxyRateClient.reportNewAction - [${this.clientName}] is using rigid circuit`
        + ` [${this.circuit.getIdentifier()}] outside of pool and cannot change. Should never call this!!`
      );
    }

    this.manager.reportNewAction(action, this.circuit);
  }
};


module.exports = ProxyRateClient;
