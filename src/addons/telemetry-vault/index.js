/**
 * Deadplug Enterprise License Vault Addon
 */
module.exports = function register(hooks) {
  hooks.addFilter('system_telemetry', (telemetry) => {
    return {
      ...telemetry,
      license: {
        tier: 'Enterprise / Atelier Fleet',
        status: 'VERIFIED_ACTIVE',
        issuer: 'deadplug.digital atelier verification authority',
        commercial_rights: true,
        white_label: true
      }
    };
  }, 10, 'telemetry-vault');
};
