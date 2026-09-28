-- The brief reads every outlet.
--
-- The second half of 0067. The brief now carries the major stories across the outlets the system
-- polls, as well as the followed names, and it reads them from the general news stream
-- (`mostCarried` in lib/news/stream.ts, 0065). The stream is defined by `news_sources`: which feeds
-- are active and `in_stream`, and the `outlet` each belongs to, which is what "carried by three
-- outlets" counts and what the brief names beside every major update.
--
-- `data_scope` is asserted against the handler's READS before the model is called, and the scope
-- is how "what runs unattended, over what data" is answered from the table and not from a grep.
-- The brief has joined `news_sources` for a feed's label since 0023 without the row naming it. Now
-- that it runs unattended and publishes outlet names to everybody's inbox with nobody reading it
-- first, the row names it.
UPDATE agents
   SET data_scope = data_scope || ARRAY['news_sources']
 WHERE key = 'news-brief' AND NOT ('news_sources' = ANY (data_scope));

DO $$
DECLARE scope text[];
BEGIN
    SELECT a.data_scope INTO scope FROM agents a WHERE a.key = 'news-brief';
    IF scope IS NULL THEN
        RAISE EXCEPTION 'the news brief is not seeded; 0023 must come first';
    END IF;
    -- Everything `mostCarried` touches, beside what the followed-name half already read.
    IF NOT (ARRAY['news_items', 'news_sources', 'news_matches', 'companies'] <@ scope) THEN
        RAISE EXCEPTION 'the news brief cannot read the stream its data_scope does not name';
    END IF;
END $$;
