-- Access changes must invalidate existing sessions, including admin MFA sessions.
CREATE FUNCTION revoke_sessions_on_access_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.disabled IS DISTINCT FROM OLD.disabled THEN
    DELETE FROM sessions WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_access_session_revocation AFTER UPDATE OF role,disabled ON users
FOR EACH ROW EXECUTE FUNCTION revoke_sessions_on_access_change();
