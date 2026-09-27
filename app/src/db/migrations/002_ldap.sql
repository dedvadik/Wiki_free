-- ============================================================================
--  002_ldap.sql — поддержка входа через LDAP / Active Directory
-- ============================================================================
--  auth_source — откуда пользователь:
--    'local' — зарегистрирован на сайте, пароль (bcrypt-хеш) хранится у нас;
--    'ldap'  — создан автоматически при первом входе через LDAP, пароль
--              проверяет сервер каталога, у нас пароль НЕ хранится.
--  ldap_dn     — Distinguished Name записи в каталоге. По нему находим
--              пользователя при следующих входах, даже если изменился логин.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN auth_source VARCHAR(20) NOT NULL DEFAULT 'local'
    CHECK (auth_source IN ('local', 'ldap')),
  ADD COLUMN ldap_dn TEXT;

-- У LDAP-пользователей нет локального пароля.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Один DN — одна учётная запись (без учёта регистра: в LDAP DN регистронезависимы).
CREATE UNIQUE INDEX users_ldap_dn_idx ON users (lower(ldap_dn)) WHERE ldap_dn IS NOT NULL;
