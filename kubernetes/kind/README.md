# WikiSpace в Kubernetes от Docker Desktop (kind, 4 узла)

Пошаговая инструкция для кластера, который Docker Desktop создаёт с провайдером **kind**: один управляющий узел `desktop-control-plane` и три рабочих — `desktop-worker`, `desktop-worker2`, `desktop-worker3`. Команды написаны для **PowerShell** в папке репозитория (`cd E:\clodeDB`). Где в Git Bash команда отличается, приведён второй вариант.

## Что получится

```text
desktop-control-plane   системные компоненты Kubernetes (обычные pod'ы сюда не попадают — taint)

desktop-worker          desktop-worker2         desktop-worker3
┌────────────────┐     ┌────────────────┐      ┌────────────────┐
│ web (копия 1)  │     │ web (копия 2)  │      │ web (копия 3)  │   3…9 копий, поровну по узлам
│ PostgreSQL #1  │     │ PostgreSQL #2  │      │ PostgreSQL #3  │   основной + 2 реплики, строго по одному
│ pooler-rw/ro   │     │ pooler-rw/ro   │      │                │   PgBouncer, копии на разных узлах
│                │     │ NFS-сервер     │      │ ingress-nginx  │   (узлы для этих — на усмотрение планировщика)
└────────────────┘     └────────────────┘      └────────────────┘
        ▲ общий том загрузок (NFS, ReadWriteMany) — один на все копии web
```

Кроме самого портала в кластер ставятся четыре готовых компонента. Всё — через Helm:

| Компонент | Зачем | Шаг |
| --- | --- | --- |
| metrics-server | загрузка CPU для автомасштабирования (HPA) | 3 |
| ingress-nginx | вход в портал по `http://localhost` | 4 |
| nfs-server-provisioner | общий том загрузок для копий на разных узлах | 5 |
| оператор CloudNativePG | кластер PostgreSQL с репликами и переключением при сбое | 6 |

Что проверено заранее на вашем кластере (Kubernetes 1.36.1):
- образ, собранный локальным `docker build`, узлы берут сами через зеркало Docker Desktop (`registry-mirror:1273`), реестр не нужен;
- на узлах есть клиент NFS;
- хранилище по умолчанию — `standard` (local-path, том живёт на одном узле);
- metrics-server и Ingress-контроллера нет, их ставим ниже.

---

## Шаг 0. Подготовка

### Память для Docker Desktop

Все четыре узла — контейнеры одной виртуальной машины Docker Desktop. Каждый «видит» всю её память, но на деле память общая. Файла `%UserProfile%\.wslconfig` у вас нет, поэтому WSL получает половину памяти компьютера (около 3,9 ГБ) — впритык для кластера из 4 узлов, PostgreSQL ×3 и портала. Рекомендуется 5–6 ГБ.

1. Создайте файл `C:\Users\<вы>\.wslconfig`:
   ```ini
   [wsl2]
   memory=6GB
   ```
2. Закройте Docker Desktop и выполните `wsl --shutdown`.
3. Запустите Docker Desktop снова и подождите, пока в его окне Kubernetes станет зелёным.

Если память на компьютере в дефиците, освободите её: закройте лишнее. Ваш портал в `docker compose` на порту 8080 можно остановить командой `docker compose stop`, а позже запустить снова через `docker compose start`.

### Подключение к кластеру

```powershell
kubectl config use-context docker-desktop
kubectl get nodes
```

Все четыре узла должны быть `Ready`.

---

## Шаг 1. Helm

```powershell
winget install --id Helm.Helm -e
```

Закройте и откройте терминал заново (чтобы обновился `PATH`), затем проверьте:

```powershell
helm version
```

---

## Шаг 2. Образ приложения

```powershell
docker build -t wikispace:1.0.0 .
```

Отдельно загружать образ в кластер не нужно: узлы kind в Docker Desktop тянут образы через зеркало, которое отдаёт образы локального Docker. Если хотите убедиться, подтяните его на любой узел (команда только кэширует образ):

```powershell
docker exec desktop-worker crictl pull docker.io/library/wikispace:1.0.0
```

> **При каждой новой сборке меняйте тег** (1.0.1, 1.0.2…). Узлы кэшируют образ, и с тем же тегом взяли бы старую версию.

---

## Шаг 3. metrics-server — данные для автомасштабирования

```powershell
helm upgrade --install metrics-server metrics-server --repo https://kubernetes-sigs.github.io/metrics-server/ -n kube-system --set "args={--kubelet-insecure-tls}"
```

`--kubelet-insecure-tls` нужен потому, что у kubelet в kind самоподписанные сертификаты. Через 1–2 минуты проверьте:

```powershell
kubectl top nodes
```

Должна появиться загрузка CPU и памяти по каждому узлу.

---

## Шаг 4. ingress-nginx — вход в портал

```powershell
helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx -n ingress-nginx --create-namespace
kubectl -n ingress-nginx get svc ingress-nginx-controller
```

Сервис имеет тип `LoadBalancer`, внешний адрес ему выдаёт встроенный в Docker Desktop cloud-provider-kind. Подождите, пока в колонке `EXTERNAL-IP` появится адрес вместо `<pending>`, и проверьте:

```powershell
curl.exe -i http://localhost/
```

Ответ `404 Not Found` от nginx означает, что всё в порядке: контроллер работает, просто портала ещё нет.

**Если `localhost` не отвечает** (порт 80 занят IIS или другой программой, или адрес не появился), пробросьте порт вручную. Окно с этой командой держите открытым:

```powershell
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8081:80
```

Тогда дальше везде вместо `http://localhost` используйте `http://localhost:8081`.

---

## Шаг 5. NFS — общий том для загрузок

Каждая копия портала работает на своём узле, а загруженные файлы должны видеть все. Стандартное хранилище kind хранит том на одном узле, поэтому поднимаем NFS-сервер внутри кластера. Он даёт класс хранения `nfs` с доступом ReadWriteMany.

```powershell
helm upgrade --install nfs nfs-server-provisioner --repo https://kubernetes-sigs.github.io/nfs-ganesha-server-and-external-provisioner/ -n nfs --create-namespace -f kubernetes/kind/nfs-values.yaml
kubectl -n nfs get pods
kubectl get storageclass nfs
```

**Обязательно проверьте том до установки портала:**

```powershell
kubectl apply -f kubernetes/kind/nfs-test.yaml
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/nfs-reader --timeout=180s
kubectl logs nfs-reader
kubectl delete -f kubernetes/kind/nfs-test.yaml
```

Ожидается строка `узел desktop-worker3 прочитал: записано на узле desktop-worker`: файл, записанный на одном узле, виден на другом. Если pod'ы висят в `ContainerCreating` с ошибкой монтирования — см. раздел [«Если что-то пошло не так»](#если-что-то-пошло-не-так).

---

## Шаг 6. Оператор CloudNativePG — PostgreSQL с репликами

Образы CloudNativePG лежат в `ghcr.io`. Иногда он качает очень медленно, поэтому надёжнее заранее скачать их через Docker: зеркало Docker Desktop раздаст их всем узлам, и каждый узел не будет качать их отдельно. Теги ниже — для оператора 1.30.1 (Helm-чарт 0.29.1):

```powershell
docker pull ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1
docker pull ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie
docker pull ghcr.io/cloudnative-pg/pgbouncer:1.25.2
```

Установка оператора:

```powershell
helm upgrade --install cnpg cloudnative-pg --repo https://cloudnative-pg.github.io/charts -n cnpg-system --create-namespace --wait
kubectl -n cnpg-system get pods
```

Pod `cnpg-cloudnative-pg-…` должен быть `Running` и `1/1`.

---

## Шаг 7. WikiSpace

```powershell
helm upgrade --install wiki ./kubernetes/helm/wikispace -n wiki --create-namespace -f kubernetes/kind/values.yaml
```

Все настройки для вашего кластера — в [values.yaml](values.yaml), с комментариями. Наблюдайте за запуском (выход — Ctrl+C):

```powershell
kubectl -n wiki get pods -o wide -w
```

Что будет происходить, 2–5 минут, если образы уже скачаны:
1. `wiki-wikispace-db-1-initdb` создаёт базу, затем стартует `wiki-wikispace-db-1` — основной сервер.
2. `db-2` и `db-3` копируют данные с основного (`…-join`) и становятся репликами, **каждая на своём рабочем узле**.
3. Запускаются пулеры `…-pooler-rw-…` и `…-pooler-ro-…`, по 2 копии.
4. Копии `wiki-wikispace-web-…` в init-контейнере `prepare-db` ждут базу. Пока её нет, они показывают `Init:0/1`, а через 5 минут ожидания — `Init:CrashLoopBackOff`: это нормально, они перезапускают ожидание. Затем одна копия применяет миграции и создаёт администратора и демо-пространство, остальные видят готовую базу.
5. Три копии web переходят в `Running 1/1` — **по одной на каждом рабочем узле** (колонка `NODE`).

Итоговая проверка:

```powershell
kubectl -n wiki get cluster          # 3 экземпляра, STATUS: Cluster in healthy state
kubectl -n wiki get pooler           # pooler-rw и pooler-ro
kubectl -n wiki get hpa              # TARGETS: cpu: 3%/70%, REPLICAS: 3
kubectl -n wiki get pods -o wide     # на каком узле какой блок
```

---

## Шаг 8. Вход

Откройте **http://localhost** (или `http://localhost:8081` при пробросе порта). Логин — `admin`, пароль:

```powershell
$b64 = kubectl -n wiki get secret wiki-wikispace-app -o jsonpath='{.data.ADMIN_PASSWORD}'
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
```

Git Bash: `kubectl -n wiki get secret wiki-wikispace-app -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d; echo`

---

## Шаг 9. Посмотреть отказоустойчивость и масштабирование в деле

Держите во втором окне терминала:

```powershell
kubectl -n wiki get pods -o wide -w
```

### Автомасштабирование под нагрузкой

1. Наполните базу тестовыми данными: 3000 страниц, 200 пользователей, около 10 секунд.
   ```powershell
   kubectl -n wiki exec deploy/wiki-wikispace-web -c web -- node src/tools/seed-load.js --yes --pages 3000 --users 200
   ```
2. Дайте нагрузку на 4 минуты: 40 пользователей без пауз, через Ingress.
   ```powershell
   docker run --rm -i -v "${PWD}\app\tests\load:/scripts" grafana/k6 run -e BASE_URL=http://host.docker.internal -e VUS=40 -e DURATION=4m /scripts/read-capacity.js
   ```
   Git Bash: `-v "$PWD/app/tests/load:/scripts"`; при пробросе порта — `BASE_URL=http://host.docker.internal:8081`.
3. Смотрите: `kubectl -n wiki get hpa -w`.
   - Загрузка CPU перевалит за 70%, и HPA за 15–30 секунд добавит копии, вплоть до 9 — по три на каждом рабочем узле.
   - После окончания нагрузки HPA 5 минут ждёт, а затем убирает по одной копии в минуту, до трёх.
4. Уберите тестовые данные: `kubectl -n wiki exec deploy/wiki-wikispace-web -c web -- node src/tools/seed-load.js --clean`

### Падение копии портала

```powershell
kubectl -n wiki get pods -l app.kubernetes.io/component=web
kubectl -n wiki delete pod <имя-любой-копии-web>
```

Сайт продолжает работать на остальных копиях. Kubernetes поднимает замену за ~20 секунд на том же или другом узле.

### Сбой основного PostgreSQL

```powershell
kubectl -n wiki get cluster                                  # колонка PRIMARY — имя основного сервера
kubectl -n wiki delete pod <имя-основного> --grace-period=0 --force
kubectl -n wiki get cluster -w
```

Статус станет `Failing over`, и через 10–30 секунд основным станет одна из реплик: имя в `PRIMARY` сменится. Удалённый экземпляр вернётся репликой, кластер снова 3/3. Портал после короткой паузы продолжит работать без перезапуска копий. Можете обновлять страницу в браузере всё это время.

### Вывод узла на обслуживание

```powershell
kubectl drain desktop-worker2 --ignore-daemonsets --delete-emptydir-data
```

- Копии web переедут на другие узлы. PodDisruptionBudget не даст выселить больше, чем допустимо: как минимум 2 копии работают всегда.
- Экземпляр PostgreSQL с этого узла будет ждать (`Pending`): его том живёт на этом узле, а на двух других уже есть по экземпляру (правило «строго по одному на узел»). Кластер при этом работает на двух экземплярах.

Верните узел:

```powershell
kubectl uncordon desktop-worker2
```

### Обновление приложения без простоя

```powershell
docker build -t wikispace:1.0.1 .
helm upgrade wiki ./kubernetes/helm/wikispace -n wiki -f kubernetes/kind/values.yaml --set image.tag=1.0.1
kubectl -n wiki rollout status deploy/wiki-wikispace-web
```

Копии обновляются по одной: сначала готова новая, потом останавливается старая. Пароль и сессии сохраняются. Чтобы не передавать тег каждый раз, поменяйте `image.tag` в `values.yaml`.

---

## Шаг 10. Настройка под себя

Правьте [values.yaml](values.yaml) и применяйте командой `helm upgrade wiki ./kubernetes/helm/wikispace -n wiki -f kubernetes/kind/values.yaml`. Самое полезное:

| Параметр | Что меняет |
| --- | --- |
| `app.adminPassword` | свой пароль администратора (действует только на пустой базе) |
| `ingress.host` | имя сайта, например `wiki.localhost` (пусто — любое имя) |
| `web.autoscaling.minReplicas` / `maxReplicas` | сколько копий минимум и максимум |
| `web.autoscaling.targetCPUUtilizationPercentage` | при какой загрузке добавлять копии |
| `web.autoscaling.behavior.scaleDown.stabilizationWindowSeconds` | сколько ждать перед уменьшением числа копий (по умолчанию 300 с) |
| `postgresql.cnpg.instances` | экземпляров PostgreSQL (не больше числа рабочих узлов при `podAntiAffinityType: required`) |
| `app.extraEnv` | любые настройки сайта, например `SETTING_SITE_NAME: "Моя вики"` |

Все параметры с пояснениями — в `kubernetes/helm/wikispace/values.yaml`, общее описание чарта — в [kubernetes/README.md](../README.md).

---

## Удаление

```powershell
helm uninstall wiki -n wiki
kubectl delete namespace wiki
```

Удаление пространства имён `wiki` стирает базу и загруженные файлы. Вспомогательные компоненты удаляются так же, если больше не нужны:

```powershell
helm uninstall cnpg -n cnpg-system
helm uninstall nfs -n nfs
helm uninstall ingress-nginx -n ingress-nginx
helm uninstall metrics-server -n kube-system
```

---

## Если что-то пошло не так

Главная команда для любой проблемы: `kubectl -n wiki describe pod <имя>`. Внизу вывода, в разделе **Events**, написана причина.

| Симптом | Причина и решение |
| --- | --- |
| pod'ы PostgreSQL или пулеров долго в `Init` / `PodInitializing`, в Events — `Pulling image "ghcr.io/…"` | медленно качается образ с ghcr.io. Скачайте его через Docker (`docker pull <образ из Events>`), зеркало Docker Desktop отдаст его узлам. **Запасной вариант:** в `values.yaml` раскомментируйте `imageName: postgres:17-alpine` и `extraSpec` (официальный образ с Docker Hub, проверен с CloudNativePG 1.30.1) и выключите пулеры (`pooler.enabled: false`, они тоже из ghcr.io). Затем `helm upgrade …` |
| web в `Init:CrashLoopBackOff` | init-контейнер 5 минут ждёт базу и перезапускается. Нормально, пока PostgreSQL не готов (`kubectl -n wiki get cluster`). Подробности: `kubectl -n wiki logs <pod> -c prepare-db` |
| web в `Pending`: `didn't match pod topology spread constraints` / `Insufficient memory` | мало памяти. Увеличьте её Docker Desktop (шаг 0) или уменьшите `web.autoscaling.minReplicas` |
| PVC `wiki-wikispace-uploads` в `Pending` | не работает NFS-сервер: `kubectl -n nfs get pods`, `kubectl -n nfs logs <pod>` |
| web в `ContainerCreating`, в Events — `MountVolume.SetUp failed … nfs` | узел не смог смонтировать NFS. **Запасной вариант:** все копии web на одном узле с обычным томом — в `values.yaml` задайте `persistence.accessMode: ReadWriteOnce`, `persistence.storageClass: standard` и `web.nodeSelector: { kubernetes.io/hostname: desktop-worker }`. Масштабирование работает, но копии web будут на одном узле |
| `kubectl get hpa` показывает `<unknown>/70%` | metrics-server ещё не собрал данные (подождите 1–2 минуты) или не установлен (шаг 3) |
| web в `ErrImagePull` / `ImagePullBackOff` | образа с таким тегом нет в локальном Docker: `docker images wikispace` и тег в `values.yaml` должны совпадать |
| `http://localhost` не открывается | `kubectl -n ingress-nginx get svc` — есть ли `EXTERNAL-IP`; порт 80 может быть занят. Используйте проброс порта (шаг 4) |
| pod'ы `OOMKilled`, всё медленно | не хватает памяти виртуальной машине Docker Desktop (шаг 0) |

## Шпаргалка: все команды по порядку

```powershell
cd E:\clodeDB
kubectl config use-context docker-desktop
winget install --id Helm.Helm -e                     # затем перезапустить терминал
docker build -t wikispace:1.0.0 .
helm upgrade --install metrics-server metrics-server --repo https://kubernetes-sigs.github.io/metrics-server/ -n kube-system --set "args={--kubelet-insecure-tls}"
helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx -n ingress-nginx --create-namespace
helm upgrade --install nfs nfs-server-provisioner --repo https://kubernetes-sigs.github.io/nfs-ganesha-server-and-external-provisioner/ -n nfs --create-namespace -f kubernetes/kind/nfs-values.yaml
kubectl apply -f kubernetes/kind/nfs-test.yaml; kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/nfs-reader --timeout=180s; kubectl logs nfs-reader; kubectl delete -f kubernetes/kind/nfs-test.yaml
docker pull ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1; docker pull ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie; docker pull ghcr.io/cloudnative-pg/pgbouncer:1.25.2
helm upgrade --install cnpg cloudnative-pg --repo https://cloudnative-pg.github.io/charts -n cnpg-system --create-namespace --wait
helm upgrade --install wiki ./kubernetes/helm/wikispace -n wiki --create-namespace -f kubernetes/kind/values.yaml
kubectl -n wiki get pods -o wide -w
```
