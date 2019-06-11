// load externals

const AdvancedProxiedRequest = require("./lib/AdvancedProxiedRequest");

module.exports = {
  ProxyRateManager: require("./lib/ProxyRateManager"),
  AdvancedProxiedRequest: AdvancedProxiedRequest.AdvancedProxiedRequest, // pass actual class
  advancedrequest: AdvancedProxiedRequest.advancedrequest, // pass for setting interval waits
  IPCheckRequest: AdvancedProxiedRequest.IPCheckRequest, // not necessary
};
