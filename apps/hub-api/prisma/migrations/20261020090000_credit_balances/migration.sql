ALTER TABLE included_usage ADD COLUMN credit_key TEXT, ADD COLUMN erased_at TIMESTAMP(3);

CREATE TABLE included_credit_balances (
  credit_key TEXT NOT NULL,
  period TEXT NOT NULL,
  used_usd DECIMAL(20,10) NOT NULL DEFAULT 0,
  PRIMARY KEY (credit_key, period)
);

CREATE INDEX included_credit_balances_period_idx ON included_credit_balances (period);
