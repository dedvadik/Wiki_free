-- ============================================================================
--  005_performance.sql — индексы по итогам нагрузочного тестирования
-- ============================================================================
--  На базе в 20 000 страниц (tests/load, src/tools/seed-load.js) выяснилось:
--
--  1. pages_parent_idx — «дочерние страницы» (WHERE parent_id = …) и признак
--     «у страницы есть дочерние» в дереве навигации. Имеющийся индекс
--     (space_id, parent_id, position) для поиска только по parent_id не
--     подходит, и каждый показ статьи просматривал всю таблицу.
--
--  2. pages_title_trgm_idx — поиск подстроки в заголовке (title ILIKE '%…%').
--     Условие «совпало по полнотекстовому индексу ИЛИ по подстроке в
--     заголовке» можно выполнить по индексам, только если индекс есть у
--     обеих частей; без триграммного индекса PostgreSQL читал все страницы
--     при КАЖДОМ поиске — даже по несуществующему слову (~0,35 с на 20 000).
--     Триграммы — расширение pg_trgm из стандартной поставки PostgreSQL.
--     Если прав на CREATE EXTENSION нет (внешняя база с урезанными правами),
--     миграция не падает: поиск работает, просто медленнее.
-- ============================================================================

CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages (parent_id);

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS pages_title_trgm_idx ON pages USING GIN (title gin_trgm_ops);
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE 'pg_trgm недоступно (%), поиск по подстроке в заголовке будет без индекса', SQLERRM;
END
$$;
