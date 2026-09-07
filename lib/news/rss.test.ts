import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedDate, NotAFeed, parseFeed } from './rss.ts';

const rss = (items: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>A feed</title>${items}</channel></rss>`;

test('an RSS item comes back whole', () => {
  const [item] = parseFeed(rss(`
    <item>
      <title>Praj wins ethanol order</title>
      <link>https://example.com/a</link>
      <guid isPermaLink="false">tag:example,2026:1</guid>
      <description>&lt;p&gt;The company said &amp;amp; confirmed.&lt;/p&gt;</description>
      <pubDate>Sun, 07 Sep 2026 09:30:00 +0530</pubDate>
    </item>`));
  assert.equal(item?.title, 'Praj wins ethanol order');
  assert.equal(item?.guid, 'tag:example,2026:1');
  assert.equal(item?.url, 'https://example.com/a');
  assert.equal(item?.summary, 'The company said & confirmed.', 'markup and entities both go');
  assert.equal(item?.publishedAt, '2026-09-07T04:00:00.000Z');
});

test('an Atom entry comes back the same way', () => {
  const [item] = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>A story</title>
      <id>urn:uuid:1</id>
      <link rel="alternate" href="https://example.com/b"/>
      <summary>Some words</summary>
      <published>2026-09-07T09:30:00Z</published>
    </entry></feed>`);
  assert.equal(item?.url, 'https://example.com/b', 'Atom puts the link in an attribute');
  assert.equal(item?.guid, 'urn:uuid:1');
  assert.equal(item?.publishedAt, '2026-09-07T09:30:00.000Z');
});

test('CDATA is unwrapped', () => {
  const [item] = parseFeed(rss(
    '<item><title><![CDATA[Sugar mills & ethanol]]></title><link>https://x/c</link></item>',
  ));
  assert.equal(item?.title, 'Sugar mills & ethanol');
});

test('SEBI’s date format is read', () => {
  // "07 Sep, 2026 +0530" defeats Date.parse twice over: the comma, and an offset with no time of
  // day behind it. Thirty regulatory notices arrived undated because of it.
  assert.equal(feedDate('07 Sep, 2026 +0530'), '2026-09-06T18:30:00.000Z');
  assert.equal(feedDate('07 Sep, 2026 11:45:00 +0530'), '2026-09-07T06:15:00.000Z');
  assert.equal(feedDate('07 Sep 2026 Z'), '2026-09-07T00:00:00.000Z');
});

test('a date that cannot be read is nothing, and the item still arrives', () => {
  const [item] = parseFeed(rss(
    '<item><title>T</title><link>https://x/d</link><pubDate>last Tuesday</pubDate></item>',
  ));
  assert.equal(item?.publishedAt, null, 'a headline with no date is still a headline');
  assert.equal(item?.title, 'T');
});

test('a story from the future is a broken feed, not a scoop', () => {
  assert.equal(feedDate('Sun, 07 Sep 2035 09:30:00 +0530'), null);
  assert.equal(feedDate('Sun, 07 Sep 1990 09:30:00 +0530'), null);
});

test('an item with no guid is identified by its link', () => {
  // PIB publishes a title and a link and nothing else.
  const [item] = parseFeed(rss('<item><title>T</title><link>https://x/e</link></item>'));
  assert.equal(item?.guid, 'https://x/e');
});

test('an item with no link or no title is not an item', () => {
  assert.equal(parseFeed(rss('<item><title>No link</title></item>')).length, 0);
  assert.equal(parseFeed(rss('<item><link>https://x/f</link></item>')).length, 0);
});

test('a feed with no items is empty, and a page that is not a feed is an error', () => {
  // The difference matters: one is a quiet morning, the other is a login page with a 200 on it.
  assert.deepEqual(parseFeed(rss('')), []);
  assert.throws(() => parseFeed('<html><body>Access denied</body></html>'), NotAFeed);
});
