/**
 * Brutalist Markdown & Dropcap Enhancer
 */
module.exports = function register(hooks) {
  hooks.addFilter('the_content', (html) => {
    if (!html) return html;

    // Replace [glitch]...[/glitch]
    html = html.replace(/\[glitch\](.*?)\[\/glitch\]/gis, (match, text) => {
      return `<span class="dl-glitch-text" data-text="${text}">${text}</span>`;
    });

    // Replace [pullquote author="..."]...[/pullquote]
    html = html.replace(/\[pullquote(?:\s+author="([^"]*)")?\](.*?)\[\/pullquote\]/gis, (match, author, text) => {
      return `
        <figure class="dl-editorial-pullquote">
          <blockquote class="dl-quote-body">${text.trim()}</blockquote>
          ${author ? `<figcaption class="dl-quote-author">// ${author}</figcaption>` : ''}
        </figure>
      `;
    });

    // Replace [callout type="..."]...[/callout]
    html = html.replace(/\[callout(?:\s+type="([^"]*)")?\](.*?)\[\/callout\]/gis, (match, type, text) => {
      const calloutType = type || 'notice';
      return `
        <div class="dl-callout dl-callout-${calloutType}">
          <div class="dl-callout-header">// SYSTEM NOTICE // ${calloutType.toUpperCase()}</div>
          <div class="dl-callout-body">${text.trim()}</div>
        </div>
      `;
    });

    return html;
  }, 10, 'brutalist-markdown');
};
