CREATE TABLE IF NOT EXISTS license_entries (
  id BIGSERIAL PRIMARY KEY,
  product_name VARCHAR(255) NOT NULL,
  product_description TEXT,
  email VARCHAR(255) NOT NULL,
  vendor VARCHAR(255) NOT NULL,
  expiry_date DATE NOT NULL,
  renewal_date DATE NOT NULL,
  ip VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS license_entries_expiry_idx ON license_entries(expiry_date);
CREATE INDEX IF NOT EXISTS license_entries_renewal_idx ON license_entries(renewal_date);
CREATE INDEX IF NOT EXISTS license_entries_product_idx ON license_entries(lower(product_name));
