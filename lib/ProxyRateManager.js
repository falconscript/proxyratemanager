"use strict";


const fs = require('fs'),
  ps = require('ps-node'),
  childprocessmanager = require('childprocessmanager'), // to start tor
  ProxyCircuit = require('./ProxyCircuit'),
  ProxyRateClient = require('./ProxyRateClient'),
  AdvancedProxiedRequest = require('./AdvancedProxiedRequest'),
  packagejson = require('../package.json');

const logger = require('standardlogger');
  logger.exportLoggerFunctionsToGlobal();
  logger.setLoggerVerbosity(1);


/**
 * ProxyRateManager
 *
 * Manage API Requests per IP and ensure that no user or API request exceeds them.
 * Also responsible for swapping circuits or exit nodes as necessary
 */
class ProxyRateManager {
  constructor (args={}) {
    this.version = packagejson.version || "-standalone-version-";

    // Read in cache if stored
    // This variable is a hash with many keys each in format:
    // "<ip address>": {
    //  actionName1: [], // array of Date objects of initiations for requests
    //  actionName2: [], // array of Date objects of initiations for requests
    // }
    this.cacheFilename = args.cacheFilename || `torratecache-${this.version}.json`;
    this.reqStats = fs.existsSync(this.cacheFilename) ? this._readCachedJson() : {};
    this.pendingCallbacks = [];
    this.isCurrentlyChanging = false;

    this.MAX_CHANGE_TRIES = 7;

    this.EXTERNAL_IP_CHECK_URL = args.EXTERNAL_IP_CHECK_URL || "http://localhost/raw_external_ip";

    // each user of this class should declare itself and can have its own circuit index
    this.clients = [];

    // if an exit IP is detected to be any of these, immediately switch exit IP
    this.blacklistedIPs = args.blacklistedIPs || {
      '163.172.67.180': true, // qwerty node
    };

    this.actionLimits = {}; // hash of action keys => the {limit} for an action within a rolling window
    this.actionResetTimes = {}; // hash of action keys => rolling window size in ms for {limit} of actions
  }

  /**
   * addRateLimitActionKey
   * @param {String} key - Name for action
   * @param {Number} limit - Max actions that can be taken per IP
   * @param {Number} timeForRateReset - Rolling window size in ms for which {limit} actions can be taken
   */
  addRateLimitActionKey ({key, limit=1200, timeForRateReset=1000 * 60 * 60 * 24}) { // one day by default
    this.actionLimits[key] = limit;
    this.actionResetTimes[key] = timeForRateReset;
  }

  /**
   * Pass in array of circuitDetails objects as defined in documentation.
   * @param {Array of Objects} circuitDetailsArr 
   */
  async initWithCircuits (circuitDetailsArr=[]) {
    // Array of objects detailing proxy paths (and username/password if applicable)
    this.circuits = [];
    this.namedCircuits = {}; // Circuits that can ONLY be used by name

    await this.addCircuits(circuitDetailsArr);    
  }

  async addCircuit (circuitDetails) {
    let circuit = new ProxyCircuit(circuitDetails);

    if (this._hasCircuit(circuit)) {
      DIE(`[!] ${this.constructor.name}.addCircuit - Circuit ${circuit.getIdentifier()} already exists!`);
    }

    // start tor if not started if a circuit needs it
    if (circuit.isLocalTor) {
      let wasRunning = await this._startTorIfNotStarted();
    }

    let extIp = await this._getExternalIP(circuit);
    await this._onChangedIP(circuit, extIp);

    INFO(`[+] ${this.constructor.name}.addCircuit [${circuit.getIdentifier()}] started with exit IP: ${extIp}`);
    
    // Add circuit to the circuit pool OR named circuit pool
    if (circuit.addToCyclingCircuitPool) {
      this.circuits.push(circuit); // circuit will be accessible by getRandomCircuit, forceIPChangeImmediately, etc
    } else {
      if (!circuit.name) {
        DIE(`[!] ${this.constructor.name}.addCircuit Named circuit [${circuit.getIdentifier()}] MUST have a passed name.`);
      }

      this.namedCircuits[circuit.name] = circuit;
    }

    // NOT calling this.createClient because it will be added into this.clients queue
    // and, after calling _removeCircuit, have that client moved to a DIFFERENT random circuit. Not good
    let pollingClient = new ProxyRateClient({manager: this, circuit: circuit, clientId: "POLLER", isPollingClient: true, });
    circuit.setPollingClient(pollingClient);
    this._startPoller(circuit).then(); // not awaiting since this is a separate infinite loop
  }

  async addCircuits (circuitsArr=[]) {
    for (let circuit of circuitsArr) {
      await this.addCircuit(circuit); // do synchronously
    }
  }

  _hasCircuit (circuit) { // must be ProxyCircuit instance
    let id = circuit.getIdentifier();
    return this.circuits.filter(c => c.getIdentifier() == id).length > 0;
  }

  
  async _removeCircuit (circuit) {
    circuit.markInvalid();

    // remove from circuit pool / named circuits
    if (circuit.addToCyclingCircuitPool) {
      delete this.namedCircuits[circuit.name];
    } else {
      let index = this.circuits.indexOf(circuit);

      if (index == -1) {
        DIE(`[!] ${this.constructor.name}._removeCircuit circuit [${circuit.getIdentifier()}] IS NOT IN this.circuits`, this.circuits);
      }

      this.circuits.splice(index, 1); // remove circuit
    }

    // run through existing clients and kick them off the circuit
    this.clients.forEach(client => (client.circuit == circuit) ? client._changeToRandomCircuit() : null);

    // stop tor process if no circuits left use it
    if (circuit.isLocalTor && this.circuits.filter(c => c.isLocalTor).length == 0) {
      await this._killAllTorProcesses();
    }

    return circuit;
  }

  /**
   * Call this to establish yourself as a user and be given an instance of ProxyRateClient to use
   * @param {Number|String} circuitSpecifier -
   *   - Omit argument for a random circuit
   *   - Provide number for a desired index into this.circuits (can provide 0 for first circuit)
   *   - Provide String for a desired circuit from this.namedCircuits
   *   - TODO - allow TOR specifier to ensure a circuit uses tor... or maybe also allow filter by health/clientnum
   */
  createClient (circuitSpecifier=true) { // will get a random one or first one by default
    let circuit = null;

    if (circuitSpecifier === true) {
      circuit = this._getRandomCircuit();
    } else if (typeof(circuitSpecifier) == "string") {
      circuit = this.namedCircuits[circuitSpecifier]
    } else if (!isNaN(circuitSpecifier)) {
      circuit = this.circuits[circuitSpecifier];
    }

    if (!circuit) {
      DIE(`[!] ${this.constructor.name} - NO CIRCUIT FOUND for circuitSpecifier=${circuitSpecifier}`);
    }

    let client = new ProxyRateClient({manager: this, circuit: circuit, clientId: this.clients.length});

    this.clients.push(client); // bookkeeping

    return client;
  }

  areAllCircuitsUnhealthy () {
    return this.circuits.filter(c => c.isHealthy()).length == 0;
  }

  /**
   * Get a random circuit. Used to change circuits. 
   * @param {Integer} circuitToOmit - Pass circuit to ensure you get a DIFFERENT index than currently using
   */
  _getRandomCircuit (circuitToOmit=null, omitUnhealthyCircuits=true) {
    if (this.circuits.length <= 1) {
      let c = this.circuits[0];
      WARN(`[-] ${this.constructor.name}._getRandomCircuit - Only ${this.circuits.length} circuit(s) available! (${c && c.getIdentifier()})`);
      return c;
    }

    let randomCircuit;

    do {
      let randomIndex = Math.floor(Math.random() * this.circuits.length);
      randomCircuit = this.circuits[randomIndex];

      // Don't accept circuit if it is unhealthy according to argument
      if (omitUnhealthyCircuits && !randomCircuit.isHealthy()) {
        DEBUG(`[D] ${this.constructor.name}._getRandomCircuit - Unhealthy circuit denied usage: ${randomCircuit.getIdentifier()}`);

        // All circuits are unhealthy. This would be an infinite loop - onAllCircuitsUnhealthy can be overridden
        if (this.areAllCircuitsUnhealthy()) {
          this.onAllCircuitsUnhealthy(); // By default, DIES / CRASHES PROGRAM
        } else if (circuitToOmit && circuitToOmit.isHealthy()) {
          DEBUG(`[D] ${this.constructor.name}._getRandomCircuit - All other circuits unhealthy - staying with ${circuitToOmit.getIdentifier()}`);
          return circuitToOmit;
        }
        continue;
      }
    } while (circuitToOmit && circuitToOmit.getIdentifier() == randomCircuit.getIdentifier());

    return randomCircuit;
  }

  // Callback called _getRandomCircuit is called AND all circuits are unhealthy
  onAllCircuitsUnhealthy () {
    DIE(`[!] ${this.constructor.name}.onAllCircuitsUnhealthy - All circuits unhealthy - DYING / THROWING ERROR`);
  }

  _readCachedJson () {
    return JSON.parse(fs.readFileSync(this.cacheFilename)); // return cache straightaway
  }

  async _writeOutCache () {
    let err = await new Promise((resolve, reject) => {
      fs.writeFile(this.cacheFilename, JSON.stringify(this.reqStats), resolve);
    });

    if (err) {
      throw err;
    }
  
    return;
  }

  // This is purely a memory clearing operation. Not very crucial, but clears old request timestamps
  freeOldIPData () {
    INFO(`[D] ${this.constructor.name}.freeOldIPData freeing data now...`);

    for (let ip in this.reqStats) {
      this._preenOldRequestsForIP(ip);
      let numCircuitsWithIP = this.circuits.filter(c => ip == c.getCurrentIP()).length;

      let ipStats = this.reqStats[ip];
      let numRelevantPoints = Object.keys(ipStats).filter(actionName => ipStats[actionName].length > 0);

      // delete IP key if empty (no recent requests run through it) and no circuits currently using IP
      if (numRelevantPoints == 0 && numCircuitsWithIP == 0) {
        delete this.reqStats[ip];
      }
    }
  }

  _initializeIPDataIfNotInitialized (ip) {
    if (!this.reqStats[ip]) {
      let actionArrays = {};

      for (let actionName in this.actionLimits) {
        actionArrays[actionName] = [];
      }

      this.reqStats[ip] = actionArrays;
    }
  }

  reportNewAction (actionName=null, circuit=null) {
    let exitIP = circuit.activeExitNodeIP;

    if (actionName == null) {
      DIE(`[!] ${this.constructor.name}.reportNewAction - 1st argument must be actionName!`);
    } else if (!(actionName in this.actionLimits)) {
      DIE(
        `[!] ${this.constructor.name}.reportNewAction - actionName "${actionName}" is not set with`
          + `addRateLimitActionKey. QUITTING. actionLimits:`, actionLimits
      );
    }

    // This is a race when a circuit changed. actions probably didn't occur on this exitIP
    if (!this.reqStats[exitIP]) {
      this._initializeIPDataIfNotInitialized(exitIP);
    }

    if (!this.reqStats[exitIP][actionName]) {
      this.reqStats[exitIP][actionName] = [];
    }

    this.reqStats[exitIP][actionName].push(new Date().getTime());
  }

  // Poller will check every CHECK_INTERVAL milliseconds for the current IP to catalog request timestamps
  async _startPoller (circuit) {
    while (circuit.isValid()) {
      // if restarting/changing, wait and check every second until done
      if (this.isCurrentlyChanging || this.isCurrentlyRestarting) {
        await new Promise((resolve, reject) => setTimeout(resolve, 1000));
        continue; // using this instead of while loop to ensure isValid is continually checked
      }

      let extIp = await this._getExternalIP(circuit);

      if (extIp != circuit.activeExitNodeIP) {
        await this._onUnrequestedIPChange(circuit, extIp); // External IP changed, fire event to ensure we can use it
      }

      circuit.lastIPPollTime = new Date().getTime(); // also set by _onChangedIP

      // enforce a wait until next IP query
      await new Promise((resolve, reject) => setTimeout(resolve, circuit.poll_wait_interval));
    }
  }

  // should probably eventually have these scans for all circuits...
  async _getExternalIP (circuit) {
    return await new AdvancedProxiedRequest.IPCheckRequest({
      url: this.EXTERNAL_IP_CHECK_URL,
      reqArgs: {
        proxyClient: circuit.pollingClient,
      },
    }).runAsync();
  }

  async changeIPIfNecessary (circuit, actionName=null) {
    if (this.isCurrentlyChanging) {
      // Create a promise and hang on pendingCallbacks being evaluated once IP is changed
      DEBUG(`[%] ${this.constructor.name}.changeIPIfNecessary - adding to pending callbacks`);
      return await new Promise((resolve, reject) => this.pendingCallbacks.push(resolve));
    }

    if (actionName == null) {
      DIE(`[!] ${this.constructor.name}.changeIPIfNecessary - 2nd argument must be actionName!`);
    }
    
    // check if still space to continue
    if (this._isIPAvailableForRequests(circuit.activeExitNodeIP, actionName)) {
      return false; // no need to change
    } else {
      await this._definitivelyChangeToAvailableIP(circuit); // marks this.isCurrentlyChanging = true
      return true;
    }
  }

  // Change exit nodes NOW. Potentially from hitting problem or banned IP
  async forceIPChangeImmediately (circuit) {
    DEBUG(`[D] ${this.constructor.name}.forceIPChangeImmediately - Changing IP for ${circuit.getIdentifier()}`);
    
    // another tick is already handling it probably.
    // if not, requests will fail again afterwards and call this again anyway
    if (this.isCurrentlyChanging) {
      // Create a promise and hang on pendingCallbacks being evaluated once IP is changed
      DEBUG(`[%] ${this.constructor.name}.forceIPChangeImmediately - already changing. adding to pending callbacks`);
      return await new Promise((resolve, reject) => this.pendingCallbacks.push(resolve));
    } else {
      // NOTE: Not checking _getExternalIP to see if we already changed IPs.
      // Could result in our request counts per IP being a smidge off if there was
      // an IP change before this call BUT after determining IP needs changing
      return await this._definitivelyChangeToAvailableIP(circuit); // marks this.isCurrentlyChanging = true
    }
  }

  /**
   * _onUnrequestedIPChange Called when a poller notices an IP change that was not initiated with forceIPChangeImmediately
   * @param {ProxyCircuit} circuit - The circuit who's IP has changed WITH circuit.activeExitNodeIP STILL set to old IP
   * @param {String} newIp - The new IP that circuit has changed to
   */
  async _onUnrequestedIPChange (circuit, newIp) {
    this.isCurrentlyChanging = true; // mark early
    this._initializeIPDataIfNotInitialized(newIp);

    let oldIp = circuit.activeExitNodeIP;
    let ipStats = this.reqStats[oldIp];
    let lastIPPollTime = circuit.lastIPPollTime;

    INFO(`[-] ${this.constructor.name} poller [${circuit.getIdentifier()}] - Unrequested exit IP change ${oldIp}=>${newIp} !!`);

    // Catalog these counts toward BOTH current and new IP for requests since last IP poll time TO BE SAFE
    for (let actionName in this.actionLimits) {
      let i = 0;
      let actionStats = ipStats[actionName];
      let point = null;
      
      while ((point = actionStats[actionStats.length - 1 - i]) && point > lastIPPollTime) {
        i++;
      }

      let ambiguousPoints = actionStats.slice(0, -i); // slice not splice from END, copying data points!

      // Add those points to the newIp
      this.reqStats[newIp][actionName] = this.reqStats[newIp][actionName].concat(ambiguousPoints);
    }

    // Decent time to write the cache in case of closing. Right now tor changes IP about every 15s with no provocation
    await this._writeOutCache();

    /* NOTE 12-13-18 _isIPAvailableForRequests now requires action name. This can't work now
    // Check if we can use this IP (with updated stats). Else get a new one
    if (this._isIPAvailableForRequests(newIp, SOME_ACTION_NAME)) {
      await this._onChangedIP(circuit, newIp); // newIp is not exhausted
    } else {
      await this._definitivelyChangeToAvailableIP(circuit, newIp);
    }*/

    return await this._onChangedIP(circuit, newIp); // newIp COULD be exhausted for some 
  }

  
  // remove the timestamps of old requests outside of the possible range to affect a rate limit
  _preenOldRequestsForIP (ip) {
    let now = new Date().getTime();

    for (let actionName in this.actionResetTimes) {
      let TIME_FOR_RATE_RESET = this.actionResetTimes[actionName];

      while (this.reqStats[ip][actionName].length && (now - this.reqStats[ip][actionName][0]) > TIME_FOR_RATE_RESET) {
        this.reqStats[ip][actionName].shift(); // remove first element (oldest request)
      }
    }
  }

  _isIPAvailableForRequests (ip, actionName=null) { // will return true if requests are below threshold of the set limit
    if (!this.reqStats[ip]) {
      return true; // totally fresh IP
    } else if (this.blacklistedIPs[ip]) {
      return false; // blacklisted
    } else if (actionName == null) {
      DIE(`[!] ${this.constructor.name}._isIPAvailableForRequests - 2nd argument must be actionName!`);
    }

    // Preen old request data first
    this._preenOldRequestsForIP(ip);

    // return whether or not preened results are below thresholds!
    return this.reqStats[ip][actionName].length < this.actionLimits[actionName];
  }

  _shouldPreenIPData () {
    return Object.keys(this.reqStats).length > 500;
  }

  async _onChangedIP (circuit, newIp) {
    if (!newIp) {
      DIE(`[!] ${this.constructor.name}._onChangedIP - newIp must be provided!`);
    }
    
    this._initializeIPDataIfNotInitialized(newIp);

    // Set this to current IP and run pending callbacks
    this.isCurrentlyChanging = false;

    circuit.activeExitNodeIP = newIp;
    circuit.lastIPPollTime = new Date().getTime();
    this.numUnFollowsSinceLastIPPollTime = 0;
    this.numFollowsSinceLastIPPollTime = 0;

    // Try to keep the ip list reasonable
    if (this._shouldPreenIPData()) {
      this.freeOldIPData(); 
    }

    DEBUG(`[%] ${this.constructor.name}._onChangedIP - releasing ${this.pendingCallbacks.length} pending callbacks`);

    // Fire off whatever promise resolve functions have built up while seeking new exit path
    while (this.pendingCallbacks.length) {
      let fn = this.pendingCallbacks.shift(); // start from front
      if (typeof(fn) == "function") {
        (function (fn) { // wrap might not be necessary. doing it for safety
          process.nextTick(function () { fn(true); }); // mark IP changed with true          
        })(fn);
      }
    }

    return;
  }

  // A simple pid lookup for running tor processes
  async _getListOfTorProcesses () {
    return await new Promise((resolve, reject) => {
      ps.lookup({ command: /^tor$/, psargs: 'awwxo pid,comm,args,ppid' }, (err, resultList) => {
        if (err) {
          throw new Error(err);
        }

        return resolve(resultList);
      });
    });
  }

  // starts child daemon process. won't close when/if node closes
  async _startTorIfNotStarted () {
    let isRunning = await this._checkIfTorIsRunning();
    if (isRunning) {
      this.isCurrentlyRestarting = false;
      return true; // was running already
    }

    // start tor...
    INFO(`[+] ${this.constructor.name}._startTorIfNotStarted - Tor was not running. Starting now...`);

    let torProc = new childprocessmanager({
      processPath: "tor",
      onStdout: (data) => {
        INFO(`[D] ${this.constructor.name}: New tor stdout chunk:`, data);
      },
      onStderr: (data) => {
        INFO(`[D] ${this.constructor.name}: New tor stderr chunk:`, data);
      },
      onDataLine: (line) => {
        // Full line of data received (will be called as well as onStdout, recommend only using this callback)
        //INFO("[D] New line of data from stdout:", line); // do nothing
      },
      onClose: () => {
        INFO(`[D] ${this.constructor.name}: tor process closed. Well, at least its stdin/stdout are closed`);
      },
      detached: true, // true to let process continue to run if node closes
    });

    torProc.startProc([ '--runasdaemon', '1' ]);

    // enforce a wait of 5 seconds to start up
    await new Promise((resolve, reject) => setTimeout(resolve, 5000));

    this.isCurrentlyRestarting = false;

    return false; // was not running already
  }

  async _checkIfTorIsRunning () {
    // Ensure tor is RUNNING as an external process.
    let resultList = await new Promise((resolve, reject) => {
      ps.lookup({ command: /^tor$/, psargs: 'awwxo pid,comm,args,ppid' }, (err, resultList) => {
        if (err) {
          throw new Error(err);
        }

        return resolve(resultList);
      });
    });

    return resultList.length > 0;
  }

  async forceRestartTorImmediately () {
    // Prevent requests from retrying and failing really quickly.
    // Some will fail but will retry due to advancedrequest
    this.isCurrentlyChanging = true;

    // Don't have multiple ticks trying to restart tor
    if (this.isCurrentlyRestarting) {
      INFO(`[D] ${this.constructor.name}.forceRestartTorImmediately - restart already triggered, adding to pendingCallbacks...`);
      // Create a promise and hang on pendingCallbacks being evaluated once IP is changed
      return await new Promise((resolve, reject) => { this.pendingCallbacks.push(resolve); });
    }
    this.isCurrentlyRestarting = true;

    INFO(`[D] ${this.constructor.name}.forceRestartTorImmediately - restarting tor`);

    await this._killAllTorProcesses();

    // All tors are dead. Now restart tor...
    await this._startTorIfNotStarted();
    
    //this.isCurrentlyRestarting = false; <-- will be done in _startTorIfNotStarted
    for (let circuit of this.circuits.filter(c => c.isLocalTor)) {
      let extIp = await this._getExternalIP(circuit); 
      await this._onUnrequestedIPChange(circuit, extIp); // Probably won't be same IP. Double count reqs
    }
    
    //this.isCurrentlyChanging = false; <-- will be done in _onUnrequestedIPChange

    return; // completed restart
  }

  async _killAllTorProcesses () {
    let resultList = await this._getListOfTorProcesses();

    if (!resultList.length) {
      INFO(`[D] ${this.constructor.name}._killAllTorProcesses - Tor process not found? Maybe it died? Restarting it anyway.`);
    }

    // Kill all found tor processes
    for (let p of resultList) {
      INFO(`[D] ${this.constructor.name}._killAllTorProcesses - Killing tor: PID: ${p.pid}, COMMAND: ${p.command}, ARGUMENTS: ${p.arguments}`);

      let err = await new Promise((resolve, reject) => ps.kill(p.pid, resolve));

      if (err) { // we want the timeout err if it occurs
        throw new Error(err);
      }
    }

    return resultList.length;
  }

  // internal function to definitively change to an IP address that we have not hit the limits on
  async _definitivelyChangeToAvailableIP (circuit, activeExitNodeIP=null) {
    // IP needs changing now
    this.isCurrentlyChanging = true;

    let storedExitIP = circuit.activeExitNodeIP;

    if (!actualExitIP) {
      actualExitIP = await this._getExternalIP(circuit); // fetch if not given
    }

    // causes infinite loop... I guess we shouldn't call this here
    /*if (storedExitIP == actualExitIP) {
      INFO(`[D] ${this.constructor.name}._definitivelyChangeToAvailableIP IP didn't change on us. Requested to change it`);
    } else {
      await this._onUnrequestedIPChange(circuit??, actualExitIP);
    }*/

    let numTries = 0;

    while (numTries < this.MAX_CHANGE_TRIES) {
      // change of exit node, send SIGHUP to tor
      await this._changeExitNode();

      // now check if the IP changed
      let extIp = await this._getExternalIP(circuit);

      if (extIp == actualExitIP) { // FALSE here to prevent loop. FIX LATER
        INFO(`[-] ${this.constructor.name} - failed to change exit node! Retrying... ${this.MAX_CHANGE_TRIES - numTries} left`);
        numTries++;
        continue;
      /* NOTE: 12-13-18 changed _isIPAvailableForRequests to require an actionName. This can't work now
      } else if (!this._isIPAvailableForRequests(extIp, SOME_ACTION_NAME)) {
        INFO(`[+] ${this.constructor.name} - changed to an exhausted IP: ${extIp}`);
        // did change, but to an IP we maxed the rates on - so not incrementing numTries but still trying again
        continue;*/
      } else {
        // DONE
        INFO(`[+] ${this.constructor.name} - SUCCESSFUL CHANGE after exhausting an IP. NewIP: ${extIp}`);
        await this._onChangedIP(circuit, extIp); // marks  this.isCurrentlyChanging = false;
        return; // success
      }
    }

    // UNABLE to change exit node ${numTries} in a row. That's bad
    return DIE(`[!] ERR. Failed ${numTries} times changing activeExitNodeIP from ${actualExitIP}`);
  }

  // DO NOT CALL THIS to change external IP. call forceIPChangeImmediately instead
  // This sends the SIGHUP signal to the tor process to force it to reroute
  // and get us a new external IP address.
  async _changeExitNode () {
    // Sending the tor process SIGHUP makes it change exit nodes!
    let resultList = await this._getListOfTorProcesses();

    if (!resultList.length) {
      DIE(`[D] ${this.constructor.name}._changeExitNode - Tor process not found? It probably died, now so shall we!`);
    }

    for (let p of resultList) {
      INFO(`[D] ${this.constructor.name} - tor: PID: ${p.pid}, COMMAND: ${p.command}, ARGUMENTS: ${p.arguments}`);

      // Wait 1 second before checking if tor dies. Tor won't die, so it will throw err
      // We catch err, and check after sending SIGHUP to see if IP changed from sighup 1 second ago
      let err = await new Promise((resolve, reject) => {
        ps.kill(p.pid, { signal: 'SIGHUP', timeout: 1, }, resolve); // sending SIGHUP to tor changes exit node!
      });

      if (err && err.toString() != 'Error: Kill process timeout') {
        throw new Error(err);
      }
    }

    return; // exit node (and theefore external IP) changed. COULD BE AN IP WE'RE FULL UP ON
  }
};



module.exports = ProxyRateManager;
