-- Agent 3 is cut.
--
-- "Analyse a company from scratch" — Darpan, `company-dossier` — is dropped at the fund's request,
-- 08-Sep-2026. It had produced no runs and no drafts, so nothing is orphaned and no history is
-- rewritten.
--
-- **Its number is not reused**, following the precedent set when quarterly investor letters was
-- cut: agent 6 stays the news brief and agent 7 stays forensics. A number that gets reused makes
-- every older note about "agent 3" ambiguous, and this system's whole claim is that the record
-- stays readable.
--
-- What it did that nothing else now does: assemble everything held on one company into a single
-- narrative. That was the only prompted, whole-company summariser. The forensic checklist (agent 7)
-- still covers the company-level judgement that matters most, and the company page assembles the
-- same underlying material for a person to read directly — which is what a dossier was standing in
-- for. Nothing else depended on it: `DOCUMENT_KIND` mapped it to `memo`, and `memo` remains a valid
-- kind for a memo somebody writes.

DELETE FROM agents WHERE key = 'company-dossier';

-- Cut, not disabled. A disabled row would keep showing on the registry as a thing that could be
-- switched back on, and the code behind it is gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE key = 'company-dossier') THEN
    RAISE EXCEPTION 'company-dossier survived its own deletion';
  END IF;
  IF (SELECT count(*) FROM agents) <> 6 THEN
    RAISE EXCEPTION 'expected six agents after the cut, found %', (SELECT count(*) FROM agents);
  END IF;
END $$;
