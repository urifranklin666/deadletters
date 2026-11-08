/**
 * Node identity compatibility addon.
 *
 * This addon intentionally performs no network delivery. Signed outbox/inbox
 * transport and retry handling live in src/core/federation.js.
 */
module.exports = function register(hooks, context) {
  hooks.addFilter('api_post_response', (postData) => {
    return {
      ...postData,
      mesh_node: context.getOption('site_node_handle', '@deadplug/main-node'),
      mesh_transport: 'core-federation'
    };
  }, 10, 'deadletter-mesh');
};
