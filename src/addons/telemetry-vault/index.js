/**
 * Local Telemetry & License Status Addon
 *
 * This addon is intentionally local-only. It does not contact a licensing
 * service, validate a license key, or make commercial-rights claims.
 */
module.exports = function register(hooks) {
  hooks.addFilter('system_telemetry', (telemetry) => {
    return {
      ...telemetry,
      license: {
        package_license: 'Proprietary',
        verification: 'not-performed',
        issuer: null,
        remote_heartbeat: false
      }
    };
  }, 10, 'telemetry-vault');
};
