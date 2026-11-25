-- Demotion must revoke the associated grants in the same transaction as the role update.
CREATE TRIGGER revoke_demoted_assistant_grants
AFTER UPDATE OF role ON visits
WHEN OLD.role = 'manager' AND NEW.role = 'write'
BEGIN
  UPDATE assistant_grants SET access = 'off', revision = revision + 1
  WHERE account_id = NEW.account_id AND board_id = NEW.board_id AND access != 'off';
END;
