-- What a company is in, and the words that mean it.
--
-- Both halves are carried forward from v2 as *content*, not code: the 87 terms below were written
-- against a real corpus and revised against a measured result (31% precision to 59%). A fresh list
-- would be a guess, and this one has been wrong in specific ways that were then fixed.
--
-- The sector is on the company and hand-set, like `status`. Deriving it from an exchange industry
-- classification was considered and dropped in v2: NSE's own industry string for a composites maker
-- is "Industrial Products", which names no vocabulary anybody would search for.

ALTER TABLE companies ADD COLUMN sector text;

CREATE TABLE sector_terms (
  sector text NOT NULL,
  term   text NOT NULL,
  PRIMARY KEY (sector, term)
);

INSERT INTO sector_terms (sector, term) VALUES
  ('auto', 'auto component'),
  ('auto', 'EV adoption'),
  ('auto', 'fastener'),
  ('auto', 'localisation'),
  ('auto', 'passenger vehicle'),
  ('auto', 'PLI scheme'),
  ('auto', 'production linked incentive'),
  ('auto', 'two-wheeler'),
  ('bioenergy', 'biofuel'),
  ('bioenergy', 'biogas'),
  ('bioenergy', 'blending'),
  ('bioenergy', 'distillery'),
  ('bioenergy', 'ethanol'),
  ('bioenergy', 'molasses'),
  ('bioenergy', 'renewable diesel'),
  ('bioenergy', 'sugar mill'),
  ('bioenergy', 'sustainable aviation fuel'),
  ('chemicals', 'catalyst'),
  ('chemicals', 'feedstock'),
  ('chemicals', 'intermediate'),
  ('chemicals', 'petrochemical'),
  ('chemicals', 'plant capacity'),
  ('chemicals', 'solvent'),
  ('chemicals', 'specialty chemical'),
  ('composites', 'composite pipe'),
  ('composites', 'composite tank'),
  ('composites', 'corrosion resistant'),
  ('composites', 'fiberglass'),
  ('composites', 'fibreglass'),
  ('composites', 'FRP pipe'),
  ('composites', 'FRP tank'),
  ('composites', 'glass reinforced'),
  ('composites', 'GRP pipe'),
  ('composites', 'pultrusion'),
  ('engineering', 'capital goods'),
  ('engineering', 'CNC machining'),
  ('engineering', 'die casting'),
  ('engineering', 'forging'),
  ('engineering', 'foundry'),
  ('engineering', 'machining'),
  ('engineering', 'tooling'),
  ('food', 'cold chain'),
  ('food', 'dairy plant'),
  ('food', 'food processing'),
  ('food', 'packaged food'),
  ('food', 'processing line'),
  ('metals', 'aluminium'),
  ('metals', 'lead price'),
  ('metals', 'LME price'),
  ('metals', 'scrap'),
  ('metals', 'smelter'),
  ('metals', 'steel price'),
  ('mining', 'comminution'),
  ('mining', 'concentrator'),
  ('mining', 'copper'),
  ('mining', 'grinding'),
  ('mining', 'iron ore'),
  ('mining', 'mineral processing'),
  ('mining', 'ore grade'),
  ('mining', 'tailings'),
  ('mining', 'wear part'),
  ('mobility', 'car rental'),
  ('mobility', 'employee transport'),
  ('mobility', 'fleet'),
  ('mobility', 'leasing'),
  ('mobility', 'ride hailing'),
  ('packaging', 'aluminium foil'),
  ('packaging', 'barrier film'),
  ('packaging', 'blister'),
  ('packaging', 'flexible packaging'),
  ('packaging', 'flexo'),
  ('packaging', 'label'),
  ('packaging', 'laminate'),
  ('packaging', 'printing plate'),
  ('pharma', 'active pharmaceutical'),
  ('pharma', 'API manufacturing'),
  ('pharma', 'API supply'),
  ('pharma', 'CDMO'),
  ('pharma', 'formulation'),
  ('pharma', 'generic drug'),
  ('pharma', 'USFDA'),
  ('recycling', 'circular'),
  ('recycling', 'e-waste'),
  ('recycling', 'extended producer responsibility'),
  ('recycling', 'recycl'),
  ('recycling', 'scrap'),
  ('recycling', 'secondary lead');

-- A transcript is a document like any other, which is what lets agent 2 work today: the trigger is
-- a transcript arriving, and a person pasting one in is an arrival. Fetching them automatically is
-- then just another way documents appear, rather than a precondition for the agent existing.
ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('note', 'memo', 'meeting', 'checklist', 'transcript'));
