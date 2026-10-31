const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDescription } = require('../lib/htmlSanitize');

test('event descriptions keep YouTube embeds and player attributes', () => {
  const html = '<p>Trailer</p><iframe width="560" height="315" src="https://www.youtube.com/embed/aqz-KE-bpKQ?si=example&amp;start=10" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';
  const clean = sanitizeDescription(html);
  assert.match(clean, /<p>Trailer<\/p><iframe /);
  assert.match(clean, /src="https:\/\/www\.youtube\.com\/embed\/aqz-KE-bpKQ\?si=example&amp;start=10"/);
  assert.match(clean, /title="YouTube video player"/);
  assert.match(clean, /allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"/);
  assert.match(clean, /referrerpolicy="strict-origin-when-cross-origin"/);
  assert.match(clean, /allowfullscreen/);
});

test('event descriptions support YouTube privacy mode and playlist embeds', () => {
  for (const host of ['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com']) {
    for (const path of ['/embed/aqz-KE-bpKQ', '/embed/videoseries?list=PLexample']) {
      const src = `https://${host}${path}`;
      assert.match(sanitizeDescription(`<iframe src="${src}"></iframe>`), /<iframe src="https:/);
    }
  }
});

test('event descriptions reject foreign, spoofed, relative and unsafe iframe sources', () => {
  const sources = [
    'https://example.com/embed/video',
    'https://www.youtube.com.evil.example/embed/video',
    'https://www.youtube.com@evil.example/embed/video',
    '/embed/video',
    '//www.youtube.com/embed/video',
    'http://www.youtube.com/embed/video',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'https://www.youtube.com/watch?v=video',
    'https://www.youtube.com/',
    '',
  ];
  for (const src of sources) {
    assert.equal(sanitizeDescription(`<p>Before</p><iframe src="${src}"></iframe><p>After</p>`), '<p>Before</p><p>After</p>', src);
  }
  assert.equal(sanitizeDescription('<iframe></iframe>'), '');
});

test('allowed YouTube embeds cannot introduce inline documents, scripts or event handlers', () => {
  const clean = sanitizeDescription('<iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;" onload="alert(1)"></iframe><script>alert(2)</script>');
  assert.equal(clean, '<iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ"></iframe>');
});

test('existing rich text and images still render while unsafe markup is removed', () => {
  const html = '<h2>Event</h2><p style="text-align: center"><strong>Welcome</strong></p><img src="https://example.com/image.jpg" alt="Poster" onerror="alert(1)"><a href="javascript:alert(1)">Link</a>';
  assert.equal(sanitizeDescription(html), '<h2>Event</h2><p style="text-align:center"><strong>Welcome</strong></p><img src="https://example.com/image.jpg" alt="Poster" /><a>Link</a>');
  assert.equal(sanitizeDescription(null), '');
});
