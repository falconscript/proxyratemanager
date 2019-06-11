"use strict";

const socks5httpAgent = require('socks5-http-client/lib/Agent'),
  socks5httpsAgent = require('socks5-https-client/lib/Agent'),
  advancedrequest = require('advancedrequest');


/**
 * AdvancedProxiedRequest
 * Extend AdvancedRequest to perform requests with the proxy system
 */
class AdvancedProxiedRequest extends advancedrequest.AdvancedRequest {
  constructor (args) {
    super(args);

    this.reqArgs = args.reqArgs || {};
  }

  setProxyIfApplicable () {
    // Proxy through tor if desired
    if (this.reqArgs.proxyClient) {
      // Without this, each "agent type" ["http", "https"] can only have one agent.
      // You can't use multiple SOCKS proxies on the request module without including this. ugh
      this.opts.pool = {};

      if (this.reqArgs.proxyClient.circuit.type === "socks5h") {
        // socks5 proxy
        this.opts['agentClass'] = this.opts.url.match(/^https:/) ? socks5httpsAgent : socks5httpAgent;
        this.opts['agentOptions'] = this.reqArgs.proxyClient.getSocksAgentOptions();
      } else {
        // normal proxy (http/https, not socks5)
        this.opts.proxy = this.reqArgs.proxyClient.circuit.getProxyIDString();
      }

      vDEBUG(`[D] ProxyRateManager.IPCheckRequest.setProxyIfApplicable - USIN TORPROXY host=${this.reqArgs.proxyClient.circuit.getIdentifier()}!!! this.name=${this.name}`, this.cookie);      
    } else {
      vDEBUG(`[D] ProxyRateManager.IPCheckRequest.setProxyIfApplicable - NOT using tor this.name=${this.name}`, this.cookie);      
    }
  }

  // Run on SUCCESSFUL completion of request (at least up to the HTTP layer. no connection issues)
  onFinish (result) {
    if (this.reqArgs.proxyClient && this.reqArgs.proxyClient.isPollingClient) {
      this.reqArgs.proxyClient.circuit.promoteHealth();
    }

    return super.onFinish(...arguments);
  }

  // Override .fail to catch a slew of SOCKS errors
  async fail (sleepSeconds, additionalMsg) { // note: parent classe's fail is not async
    // Continue trying for polling client, don't cause crashes
    if (this.reqArgs.proxyClient && this.reqArgs.proxyClient.isPollingClient) {
      if (this.numTriesSoFar > 3) {
        this.reqArgs.proxyClient.circuit.degradeHealth();
        this.numTriesSoFar = 4;

        await new Promise((resolve, reject) => setTimeout(resolve, 1000)); // enforce 1 second wait to slow down
      }
    }

    // Check for the errors that occur randomly but aren't a big issue
    const randomErrors = [
      'Error: socket hang up',
      'Error: SOCKS connection failed. Host unreachable.',
      'Error: SOCKS connection failed. Connection not allowed by ruleset',
      'SSL routines:SSL23_GET_SERVER_HELLO',
      'SSL routines:SSL3_GET_RECORD:wrong version number:',
      'Error: SOCKS connection failed. General SOCKS server failure.',
      // 'Error: read ECONNRESET', (also happens but only deserves 10 second wait)
    ];

    const shadyErrors = [
      'Error: unable to verify the first certificate',
      'Error: self signed certificate',
      'Error: self signed certificate in certificate chain',
      "Error [ERR_TLS_CERT_ALTNAME_INVALID]: Hostname/IP does not match certificate's altnames",
      'SSL routines:SSL3_GET_RECORD:decryption failed or bad record mac',
      'Error: unable to get local issuer certificate',
    ];

    let valueToSearchErroMessage = this.data; // was additionalMsg, COULD be unreliable...?
    let randomErrorsFound = randomErrors.filter(e => valueToSearchErroMessage.indexOf(e) != -1);
    let shadyErrorsFound = shadyErrors.filter(e => valueToSearchErroMessage.indexOf(e) != -1);

    // Check for some known annoying errors and possibly change circuit if under tor
    if (randomErrorsFound.length) {
      sleepSeconds = 60; // wait a full minute

      // Switch circuit if SOCKS CONNECTION FAILED is suffering hard
      if (this.numTriesSoFar > 5) {
        sleepSeconds = 180; // 3 minutes

        // Irritating today. Change circuit to stop this junk
        //if (randomErrorsFound[0].indexOf('Error: SOCKS connection failed. Host unreachable.') != -1) {
          // change circuit if possible
          if (this.reqArgs.proxyClient) {
            this.reqArgs.proxyClient.forceIPChangeImmediately().then();
          }
        //}
      } else {
        // If less than 5 tries... ensure only 0.1 try added for this connection and HURRY UP to try again
        if (randomErrorsFound[0] == 'Error: SOCKS connection failed. Host unreachable.') {
          sleepSeconds = 0.5;
          this.numTriesSoFar -= 0.9;

          // change circuit as well
          if (this.reqArgs.proxyClient) {
            this.reqArgs.proxyClient.forceIPChangeImmediately().then();
          }
        }
      }
    } else if (shadyErrorsFound.length) {
      INFO(`[D] ${this.constructor.name}.fail - Shady error encountered: ${shadyErrorsFound[0]}`);
      if (this.reqArgs.proxyClient) {
        this.reqArgs.proxyClient.forceIPChangeImmediately().then(); // try to switch circuits if available
      }
    }

    // Check for Tor's weird issue where it stops working after like 5000 requests or a few days... weird
    let isTorCircuit = this.reqArgs.proxyClient && this.reqArgs.proxyClient.circuit.isLocalTor;
    if (valueToSearchErroMessage.indexOf('Error: SOCKS connection failed. TTL expired.') != -1 && this.numTriesSoFar > 3 && isTorCircuit) {
      //if (this.numTriesSoFar > 7) {
        // This is a menace, we've already tried changing exit nodes. We have to restart tor.
        return this.reqArgs.proxyClient.manager.forceRestartTorImmediately().then(() => {
          return super.fail(sleepSeconds, `[!] TTL Expired error getting out of hand. Restarting tor`);
        });
      //}

      //return this.reqArgs.proxyClient.manager.forceRestartTorImmediately().then(() => {
        //return super.fail(sleepSeconds, `[!] Got TTL Expired error from IP:${exitIP} SO WE CHANGED IP.`);
      //});
    } else {
      return super.fail(sleepSeconds, additionalMsg);
    }
  }

  run () {
    this.setProxyIfApplicable(); // Needed to set the proxy details before sending request

    // actually perform request
    super.run();
  }
};


/**
 * IPCheckRequest
 * Used for poller to watch for IP changes on circuits
 */
class IPCheckRequest extends AdvancedProxiedRequest {
  constructor (args) {
    super(args);

    this.name = "IP_POLL_REQ";
  }

  postProcess () {
    if (!this.data) {
      return this.fail(40, "IPCheckRequest failed, BLANK request. Retrying 40s");
    } else if (!this.data.match(/(\d{1,3}\.){3}\d{1,3}/)) {
      return this.fail(10, "ERR getting external IP - response data failed regex:", this.data);
    } else {
      return this.onFinish(this.data.match(/(\d{1,3}\.){3}\d{1,3}/)[0]);
    }
  }
};



module.exports = {
  AdvancedProxiedRequest: AdvancedProxiedRequest,
  IPCheckRequest: IPCheckRequest,
  advancedrequest: advancedrequest, // Hook to the parent class definition
};
