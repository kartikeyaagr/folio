-- A prompt that did not fit is not malformed JSON.
--
-- `model_context_window_exceeded` is a real `StopReason` in the installed SDK and `lib/agents/
-- model.ts` handled none of it: the response fell through to the text join, hit `JSON.parse('')`
-- and was recorded as `unparseable`. So the one failure whose cause is knowable from its name was
-- filed under the one that means "we have no idea what came back".
--
-- It gets its own kind rather than joining `truncated`, because the two have opposite remedies.
-- `truncated` means the answer ran out of room and is fixed by allowing more output — which is
-- exactly what `askModel`'s retry does. `too_large` means the *question* did not fit, and allowing
-- more output makes it worse. A retry is not just useless there, it is the wrong direction.

ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_failure_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_failure_check CHECK (
  failure_kind IS NULL
  OR failure_kind = ANY (ARRAY['refusal', 'truncated', 'unparseable', 'schema_mismatch', 'too_large', 'error'])
);
