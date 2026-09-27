-- ============================================================================
--  004_space_permissions.sql — права доступа на уровне пространств
-- ============================================================================
--  Модель (подробно — src/services/permissions.js):
--    owner_id    — владелец пространства (изначально его создатель). Может
--                  управлять правами пространства. Владение можно передать.
--    visibility  — кто читает:
--                    'public'     — все, кому доступен сайт;
--                    'restricted' — только владелец, участники и администраторы.
--    edit_policy — кто из редакторов может править статьи:
--                    'editors' — все редакторы, которые видят пространство;
--                    'members' — только участники с правом редактирования.
--    space_members — участники: пользователь + уровень доступа
--                    'read' (чтение) или 'edit' (чтение и редактирование).
--
--  Существующие пространства становятся 'public' + 'editors' — ровно так они
--  и работали до этой миграции, поведение сайта не меняется.
-- ============================================================================

ALTER TABLE spaces
  ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'restricted')),
  ADD COLUMN edit_policy VARCHAR(20) NOT NULL DEFAULT 'editors'
    CHECK (edit_policy IN ('editors', 'members'));

-- Владелец существующих пространств — их создатель.
UPDATE spaces SET owner_id = created_by;

CREATE TABLE space_members (
  space_id    INTEGER     NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  access      VARCHAR(10) NOT NULL CHECK (access IN ('read', 'edit')),
  added_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);

-- Быстрая проверка «в каких пространствах участвует пользователь»
-- (фильтр поиска, ленты изменений, списка пространств).
CREATE INDEX space_members_user_idx ON space_members (user_id);
