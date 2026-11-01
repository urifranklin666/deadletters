/**
 * Deadletter P2P Mesh & Syndicator Addon
 */
module.exports = function register(hooks, context) {
  hooks.addAction('post_published', (post) => {
    console.log(`[Mesh Syndicator] Broadcasted new letter drop "${post.post_title}" (${post.drop_code}) to deadplug peer mesh.`);
  }, 10, 'deadletter-mesh');

  hooks.addAction('post_reshared', (reshare) => {
    console.log(`[Mesh Syndicator] Propagated re-letter "${reshare.title}" with signature ${reshare.signature.substring(0, 12)}...`);
  }, 10, 'deadletter-mesh');

  hooks.addFilter('api_post_response', (postData) => {
    return {
      ...postData,
      mesh_node: context.getOption('site_node_handle', '@deadplug/main-node'),
      mesh_federated: true
    };
  }, 10, 'deadletter-mesh');
};
