CREATE TRIGGER seed_assistant_client AFTER INSERT ON accounts
WHEN NEW.name GLOB 'Assistant Test Owner *'
BEGIN
  INSERT INTO assistant_clients (account_id, client_id) VALUES (NEW.id, 'e2e-assistant');
END;
