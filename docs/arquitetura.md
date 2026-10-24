# TipsBank .NET — Arquitetura

O **TipsBank** é um banco digital fictício, criado pela LinuxTips para o curso *Descomplicando Kubernetes*.
A versão original tem três microserviços em Python/FastAPI. Neste desafio, as três APIs são **reescritas em .NET 10 (LTS)**.
O contrato HTTP, a base de dados e o frontend **não mudam**.

---

## 1. Componentes

| Componente | Tipo (k8s) | Tecnologia | Porta | Responsabilidade |
|---|---|---|---|---|
| `web` | Deployment | nginx-unprivileged (Alpine) + HTML/JS vanilla | 8080 | SPA de internet banking + proxy reverso `/api/<serviço>/` → APIs. **Fornecido, não se altera.** |
| `api-contas` | Deployment | **.NET 10** ASP.NET Core | 8080 | Contas, saldo, login (bcrypt) |
| `api-transacoes` | Deployment (+ sidecar) | **.NET 10** ASP.NET Core | 8080 | Transferências, extrato; chama `api-contas` e `auditoria` |
| `log-forwarder` | sidecar da `api-transacoes` | busybox `tail -F` | — | Reencaminha `/var/log/app/app.log` |
| `auditoria` | Deployment | **.NET 10** ASP.NET Core | 8080 | Eventos em ficheiros JSONL num volume persistente |
| `postgres` | StatefulSet | PostgreSQL 16 | 5432 | Tabelas `contas` e `transacoes` |

---

## 2. Diagrama

```
                         Browser  (http://localhost:8080  |  http://tipsbank.local:8080)
                            │
                            ▼
                ┌──────────────────────────┐
                │ web  (nginx :8080)       │  /            → SPA estática
                │ ns: tipsbank-web         │  /api/contas/      → api-contas
                └───┬──────────┬──────────┬┘  /api/transacoes/  → api-transacoes
                    │          │          │   /api/auditoria/   → auditoria
        ┌───────────┘          │          └──────────────────┐
        ▼                      ▼                             ▼
┌───────────────────┐  ┌──────────────────────────────┐  ┌────────────────────────┐
│ api-contas  :8080 │◄─┤ api-transacoes :8080         ├─►│ auditoria  :8080       │
│ ns: tipsbank-     │  │ ns: tipsbank-transacoes      │  │ ns: tipsbank-auditoria │
│     contas        │  │ ┌──────────────────────────┐ │  │                        │
└─────────┬─────────┘  │ │ sidecar log-forwarder    │ │  └───────────┬────────────┘
          │            │ │ tail -F /var/log/app/... │ │              │
          │            │ └──────────────────────────┘ │              ▼
          │            └──────────────┬───────────────┘   ┌────────────────────────┐
          ▼                           ▼                   │ PVC /data              │
┌─────────────────────────────────────────────┐           │ eventos-YYYY-MM-DD.jsonl│
│ postgres :5432  (StatefulSet + PVC)         │           │ (NFS/RWX em multi-nó)  │
│ ns: tipsbank-contas   tabelas: contas,      │           └────────────────────────┘
│                       transacoes            │
└─────────────────────────────────────────────┘
```

Cadeia de chamadas: `web → api-transacoes → api-contas` e `api-transacoes → auditoria`.
A `api-contas` e a `auditoria` não chamam nenhum outro serviço.

---

## 3. Fluxo de uma transferência

```
web                api-transacoes              api-contas            postgres          auditoria
 │ POST /transferencias │                          │                     │                 │
 │─────────────────────►│ POST /contas/{o}/saldo   │                     │                 │
 │                      │ {debito}                 │ BEGIN; SELECT ...   │                 │
 │                      │─────────────────────────►│ FOR UPDATE; UPDATE  │                 │
 │                      │◄──────────── 200 ────────│ COMMIT ────────────►│                 │
 │                      │ POST /contas/{d}/saldo   │                     │                 │
 │                      │ {credito}                │                     │                 │
 │                      │─────────────────────────►│────────────────────►│                 │
 │                      │◄──────────── 200 ────────│                     │                 │
 │                      │ INSERT transacoes ───────────────────────────►│                 │
 │                      │ POST /eventos (best-effort, timeout 3 s) ─────────────────────►│ append JSONL
 │◄──── 201 ────────────│                                                                  │
```

Falhas:
- **Débito falha** (404 conta, 422 saldo) → devolve o mesmo status; nada a desfazer.
- **Crédito falha** → **compensação**: re-credita a origem e devolve o status do erro.
- **Auditoria falha** → só um warning no log; a transferência continua com sucesso (201).

> Isto é uma *saga* simplificada, sem transação distribuída. Se a própria compensação falhar, o saldo fica
> inconsistente. Discutir este risco (e possíveis soluções: outbox, idempotência, retries) faz parte da avaliação.

---

## 4. Modelo de dados

Fonte da verdade: [`../sql/init.sql`](../sql/init.sql) (corre no primeiro arranque do Postgres).

```
contas                                   transacoes
───────────────────────────────          ─────────────────────────────────
id          VARCHAR(64)  PK              id          VARCHAR(64)  PK
titular     VARCHAR(120) NOT NULL        origem_id   VARCHAR(64)  NOT NULL  (idx)
documento   VARCHAR(14)  UNIQUE (idx)    destino_id  VARCHAR(64)  NOT NULL  (idx)
senha_hash  VARCHAR(255) NOT NULL        valor       NUMERIC(15,2) NOT NULL
saldo       NUMERIC(15,2) NOT NULL       status      VARCHAR(20)  NOT NULL
criada_em   TIMESTAMP DEFAULT NOW()      criada_em   TIMESTAMP DEFAULT NOW()
```

Não há chave estrangeira entre `transacoes` e `contas`: cada tabela pertence a um serviço diferente
(*database per service* lógico), mesmo partilhando a mesma instância.

Seed: contas `1111…` (Jeferson Fernando, 10 000.00) e `2222…` (LinuxTips SA, 500.00), ambas com a senha `giropops`.

---

## 5. Contratos

| Serviço | Especificação | Manual | Testes |
|---|---|---|---|
| api-contas | [`openapi.yaml`](../api-contas/openapi.yaml) | [`MANUAL-ALUNO.md`](../api-contas/MANUAL-ALUNO.md) | [`bruno/`](../api-contas/bruno) |
| api-transacoes | [`openapi.yaml`](../api-transacoes/openapi.yaml) | [`MANUAL-ALUNO.md`](../api-transacoes/MANUAL-ALUNO.md) | [`bruno/`](../api-transacoes/bruno) |
| auditoria | [`openapi.yaml`](../auditoria/openapi.yaml) | [`MANUAL-ALUNO.md`](../auditoria/MANUAL-ALUNO.md) | [`bruno/`](../auditoria/bruno) |

Convenções comuns às três APIs:

| Tema | Regra |
|---|---|
| Porta | 8080 (`ASPNETCORE_HTTP_PORTS=8080`) |
| JSON | snake_case; valores monetários aceites como número **ou** string |
| Erros | objeto JSON com `detail` (ProblemDetails) |
| Probes | `GET /health/live`, `/health/ready` (verifica dependências), `/health/startup` |
| Métricas | `GET /metrics` no formato Prometheus |
| Logs | JSON numa linha em stdout: `{"ts","level","service","msg"}` |

---

## 6. Imagens de container

| | Original (Python) | Desafio (.NET 10) |
|---|---|---|
| Build stage | `python:3.x-slim` + `pip install --target` | `mcr.microsoft.com/dotnet/sdk:10.0` + `dotnet publish` |
| Runtime | Distroless / Chainguard Python | `mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled` |
| Shell / package manager | não | não |
| Utilizador | `nonroot` UID 65532 | `app` UID **1654** |
| Entrypoint | `python -m uvicorn main:app` | `dotnet <Projeto>.dll` |

As imagens *chiseled* são o equivalente da Microsoft ao Distroless: Ubuntu reduzido ao mínimo, sem shell,
utilizador não-root já criado. Consequências práticas:
- `docker exec ... sh` **não funciona**. Para depurar, usa `kubectl debug` com um container efémero ou um container `busybox` que monte o mesmo volume.
- Healthchecks do compose do tipo `CMD curl` não funcionam (não há curl). Usa as probes HTTP do Kubernetes.
- Volumes montados têm de ser graváveis pelo UID 1654 (init container `chown` no compose; `fsGroup` no k8s).

---

## 7. Kubernetes

```
tipsbank-contas       postgres (StatefulSet), api-contas (Deployment ×2), Secret contas-db-secret, ConfigMap init-sql
tipsbank-transacoes   api-transacoes + log-forwarder (Deployment ×2), Secret transacoes-db-secret, ConfigMap svc-url-endpoints
tipsbank-auditoria    auditoria (Deployment ×1, ×3 com NFS), PVC pvc-tipsbank-auditoria
tipsbank-web          web (Deployment ×2), ConfigMap nginx-configuration, Service LoadBalancer
```

- DNS entre namespaces: `<service>.<namespace>.svc.cluster.local:8080`.
- O `nginx.conf` do `web` é substituído por um ConfigMap com os upstreams em FQDN, por isso a imagem `web` é a mesma do compose.
- Todas as APIs correm com `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault` e um `emptyDir` em `/tmp`.
- Labels `app`, `team`, `env` em todos os workloads (compatível com políticas Kyverno de *require labels*).

Manifests de exemplo em [`../k8s/`](../k8s), aplicados por ordem numérica.

---

## 8. Observabilidade

| Serviço | Métricas de negócio |
|---|---|
| api-contas | `tipsbank_login_total{status}` |
| api-transacoes | `transacoes_total{status=ok\|falha_debito\|falha_credito}` |
| auditoria | `auditoria_eventos_total{tipo}`, `auditoria_arquivo_bytes` |
| todas (exceto auditoria) | `http_requests_total{method,path,status}`, `http_request_duration_seconds{path}` |

Os nomes das métricas são iguais aos da versão Python, para que os dashboards e alertas Prometheus existentes continuem a funcionar.

---

## 9. Segurança

- Imagens multi-stage, sem SDK no runtime, não-root, root filesystem só de leitura.
- Tags imutáveis (`v1.0.0`), **nunca** `:latest`.
- 0 vulnerabilidades HIGH/CRITICAL (`trivy image`).
- Senhas só como hash bcrypt (custo 10); nunca em logs nem em respostas.
- Login devolve a mesma mensagem para documento inexistente e senha errada.
- Auditoria valida o parâmetro `dia` (bloqueia *path traversal*).
- Secrets em claro nos manifests **apenas** porque é um laboratório.
