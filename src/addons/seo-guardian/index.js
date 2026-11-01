/**
 * Deadplug SEO Guardian & Schema Engine Addon
 */
module.exports = function register(hooks, context) {
  hooks.addFilter('render_meta_tags', (metaList, post, siteConfig) => {
    if (!post) {
      return [
        ...metaList,
        { property: 'og:site_name', content: siteConfig.title },
        { property: 'og:type', content: 'website' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:creator', content: '@deadplugdigital' }
      ];
    }

    return [
      ...metaList,
      { property: 'og:title', content: post.post_title },
      { property: 'og:description', content: post.post_excerpt || post.post_title },
      { property: 'og:image', content: post.featured_image || '/uploads/deadplug_editorial_cover.jpg' },
      { property: 'og:type', content: 'article' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: post.post_title },
      { name: 'twitter:description', content: post.post_excerpt },
      { name: 'twitter:image', content: post.featured_image || '/uploads/deadplug_editorial_cover.jpg' },
      {
        type: 'application/ld+json',
        content: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: post.post_title,
          image: [post.featured_image],
          datePublished: post.post_date,
          dateModified: post.post_modified,
          author: [{
            '@type': 'Person',
            name: post.author_name || 'Deadplug Operator'
          }],
          publisher: {
            '@type': 'Organization',
            name: 'deadplug.digital',
            url: 'https://deadplug.digital'
          }
        })
      }
    ];
  }, 10, 'seo-guardian');
};
