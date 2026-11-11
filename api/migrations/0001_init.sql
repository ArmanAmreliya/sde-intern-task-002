CREATE TABLE homes (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL CONSTRAINT home_name_required CHECK (length(trim(name)) > 0)
) STRICT;

CREATE TABLE members (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  homeId TEXT NOT NULL,
  name TEXT NOT NULL CONSTRAINT member_name_required CHECK (length(trim(name)) > 0),
  CONSTRAINT member_home_exists FOREIGN KEY (homeId) REFERENCES homes(id),
  CONSTRAINT member_home_identity UNIQUE (homeId, id)
) STRICT;

CREATE INDEX members_by_home ON members (homeId, position);

CREATE TABLE bills (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  homeId TEXT NOT NULL,
  title TEXT NOT NULL CONSTRAINT bill_title_required CHECK (length(trim(title)) > 0),
  totalCents INTEGER NOT NULL CONSTRAINT bill_total_valid CHECK (totalCents BETWEEN 1 AND 9007199254740991),
  CONSTRAINT bill_home_exists FOREIGN KEY (homeId) REFERENCES homes(id),
  CONSTRAINT bill_home_identity UNIQUE (homeId, id)
) STRICT;

CREATE INDEX bills_by_home ON bills (homeId, position);

CREATE TABLE shares (
  id TEXT NOT NULL PRIMARY KEY,
  homeId TEXT NOT NULL,
  billId TEXT NOT NULL,
  memberId TEXT NOT NULL,
  amountCents INTEGER NOT NULL CONSTRAINT share_amount_valid CHECK (amountCents >= 0),
  paidAt TEXT,
  paymentKey TEXT,
  CONSTRAINT share_bill_home_matches FOREIGN KEY (homeId, billId) REFERENCES bills(homeId, id),
  CONSTRAINT share_member_home_matches FOREIGN KEY (homeId, memberId) REFERENCES members(homeId, id),
  CONSTRAINT one_share_per_member UNIQUE (billId, memberId),
  CONSTRAINT share_payment_consistent CHECK ((paidAt IS NULL) = (paymentKey IS NULL))
) STRICT;

CREATE INDEX unpaid_shares_by_member ON shares (memberId) WHERE paidAt IS NULL;
