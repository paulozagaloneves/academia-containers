# TipsBank .NET — Manual do Aluno

## O desafio

Vais pegar numa aplicação bancária real (em escala de laboratório), feita em Python, e reescrever os seus três
microserviços em **.NET 10**. Depois vais pô-la a correr:

1. em containers, com **Docker Compose**;
2. num cluster **Kubernetes**.

O frontend (`web`), a base de dados (`sql/init.sql`) e o contrato HTTP de cada API **já estão definidos e não podem mudar**.
Se o teu código respeitar o contrato, o frontend funciona sem alterações. É esse o teste final.

### Regras

1. **Não alteres** a pasta `web/` nem `sql/init.sql`.
2. Rotas, nomes de campos JSON (snake_case), códigos HTTP e nomes de métricas têm de ser **iguais** aos do `openapi.yaml` de cada serviço.
3. .NET **10** (LTS). ASP.NET Core Minimal APIs ou Controllers, à tua escolha.
4. Cada API é um projeto independente, com o seu próprio Dockerfile e a sua imagem.
5. Containers não-root, sem shell na imagem final, com tag versionada.
6. Podes usar bibliotecas NuGet open-source. Justifica as escolhas no README da tua entrega.

### Estrutura do repositório

```
Academia.Containers/
├── README.md
├── docker-compose.yml        ← ambiente local completo
├── docs/
│   ├── arquitetura.md        ← lê primeiro
│   └── manual-aluno.md       ← este ficheiro
├── sql/init.sql              ← schema + seed (não alterar)
├── web/                      ← frontend nginx (não alterar)
├── api-contas/
│   ├── Dockerfile            ← exemplo (.NET 10, multi-stage, chiseled)
│   ├── MANUAL-ALUNO.md       ← contrato detalhado + regras de negócio
│   ├── openapi.yaml          ← especificação OpenAPI 3.1
│   ├── bruno/                ← collection de testes de aceitação
│   └── src/ApiContas/        ← ★ o TEU código
├── api-transacoes/           (mesma estrutura → src/ApiTransacoes/)
├── auditoria/                (mesma estrutura → src/Auditoria/)
└── k8s/                      ← manifests Kubernetes de exemplo
```

---

## Pré-requisitos

| Ferramenta | Versão | Para quê |
|---|---|---|
| .NET SDK | 10.0.x | Desenvolver e testar localmente |
| Docker + Docker Compose v2 | recente | Build das imagens e ambiente local |
| Bruno | recente | Testes de aceitação do contrato |
| kubectl | ≥ 1.30 | Kubernetes |
| kind, minikube ou k3d (ou o cluster da Academia) | — | Cluster Kubernetes |
| Trivy | recente | Análise de vulnerabilidades das imagens |
| IDE | VS Code + C# Dev Kit ou Rider | — |

Verifica:

```bash
dotnet --version          # 10.0.x
docker compose version
kubectl version --client
trivy --version
```

---

## Etapa 0 — Perceber o sistema (½ dia)

1. Lê [`arquitetura.md`](arquitetura.md) e os três `MANUAL-ALUNO.md`.
2. Abre cada `openapi.yaml` num visualizador (extensão *OpenAPI (Swagger) Editor* do VS Code ou https://editor.swagger.io).
3. Lê [`../sql/init.sql`](../sql/init.sql) e identifica as tabelas de cada serviço.
4. Responde por escrito (fica na tua entrega):
   - Que serviço chama que serviço? Qual deles não depende de nenhum?
   - O que acontece ao saldo se o crédito no destino falhar a meio de uma transferência?
   - Porque é que a auditoria não usa base de dados?

> **Ordem recomendada:** `auditoria` (sem BD, a mais simples) → `api-contas` (BD + bcrypt) → `api-transacoes` (orquestra as outras duas).

---

## Etapa 1 — Esqueleto dos projetos

```bash
cd Academia.Containers

dotnet new web -n Auditoria     -o auditoria/src/Auditoria          --framework net10.0
dotnet new web -n ApiContas     -o api-contas/src/ApiContas         --framework net10.0
dotnet new web -n ApiTransacoes -o api-transacoes/src/ApiTransacoes --framework net10.0

# opcional: uma solution para abrir tudo na IDE
dotnet new sln -n TipsBank
dotnet sln TipsBank.sln add */src/*/*.csproj
```

Configuração base que **todas** as APIs precisam (`Program.cs`):

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);

// JSON compatível com o contrato: snake_case + números aceites como string
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
    o.SerializerOptions.NumberHandling = JsonNumberHandling.AllowReadingFromString;
});

// Erros como ProblemDetails -> o campo "detail" é lido pelo frontend
builder.Services.AddProblemDetails();

var app = builder.Build();

app.MapGet("/health/live", () => Results.Ok(new { status = "ok" }));

app.Run();
```

Testa: `dotnet run --urls http://localhost:8083` e `curl http://localhost:8083/health/live`.

---

## Etapa 2 — auditoria

Segue [`../auditoria/MANUAL-ALUNO.md`](../auditoria/MANUAL-ALUNO.md).

- Sem base de dados: só ficheiros em `DATA_DIR`. Para testar localmente, `DATA_DIR=./data dotnet run`.
- Pontos críticos: append atómico, UTC, campos `null` presentes, validação do `dia`.
- Métricas: pacote `prometheus-net.AspNetCore` (`app.MapMetrics()`).
- Valida com a collection Bruno `auditoria/bruno` (ambiente `local`, ajusta a porta se correres fora do Docker).

---

## Etapa 3 — api-contas

Segue [`../api-contas/MANUAL-ALUNO.md`](../api-contas/MANUAL-ALUNO.md).

Sobe só o Postgres do compose para desenvolver:

```bash
docker compose up -d postgres
export ConnectionStrings__TipsBank="Host=localhost;Port=5432;Database=tipsbank;Username=tipsbank;Password=tipsbank"
dotnet run --project api-contas/src/ApiContas --urls http://localhost:8081
```

Bibliotecas sugeridas:

| Necessidade | Opção A | Opção B |
|---|---|---|
| Acesso a dados | `Npgsql.EntityFrameworkCore.PostgreSQL` + `EFCore.NamingConventions` | `Dapper` + `Npgsql` |
| bcrypt | `BCrypt.Net-Next` | — |
| Health checks | `AspNetCore.HealthChecks.NpgSql` | `SELECT now()` manual |
| Métricas | `prometheus-net.AspNetCore` | OpenTelemetry + exporter Prometheus |

Pontos críticos: `decimal` para dinheiro, `SELECT ... FOR UPDATE` dentro de transação no ajuste de saldo,
login com as contas seed (`giropops`), nunca devolver `senha_hash`.

---

## Etapa 4 — api-transacoes

Segue [`../api-transacoes/MANUAL-ALUNO.md`](../api-transacoes/MANUAL-ALUNO.md).

Precisa das outras duas a correr (local ou no compose):

```bash
export ConnectionStrings__TipsBank="Host=localhost;Port=5432;Database=tipsbank;Username=tipsbank;Password=tipsbank"
export CONTAS_URL=http://localhost:8081 AUDITORIA_URL=http://localhost:8083 APP_VERSION=v1
dotnet run --project api-transacoes/src/ApiTransacoes --urls http://localhost:8082
```

Pontos críticos: algoritmo com **compensação**, propagação do status code, auditoria *best-effort*,
`IHttpClientFactory` com timeouts, header `X-App-Version`, log também em `/var/log/app/app.log`
(localmente usa uma variável para mudar o caminho, ex. `LOG_FILE=./app.log`).

---

## Etapa 5 — Imagens Docker

Cada serviço tem um `Dockerfile` de exemplo. Lê os comentários: assume `src/<Projeto>/<Projeto>.csproj`.

```bash
docker build -t tipsbank-auditoria:v1.0.0      ./auditoria
docker build -t tipsbank-api-contas:v1.0.0     ./api-contas
docker build -t tipsbank-api-transacoes:v1.0.0 ./api-transacoes

docker images | grep tipsbank          # compara tamanhos com a versão Python
docker inspect tipsbank-api-contas:v1.0.0 --format '{{.Config.User}}'   # 1654 ou $APP_UID
```

Análise de vulnerabilidades (critério: **0 HIGH/CRITICAL**):

```bash
trivy image --severity HIGH,CRITICAL --exit-code 1 tipsbank-api-contas:v1.0.0
```

Perguntas para o relatório:
- Qual a diferença de tamanho entre `sdk:10.0`, `aspnet:10.0` e `aspnet:10.0-noble-chiseled`?
- Porque é que copiamos o `.csproj` e fazemos `restore` antes de copiar o resto do código?
- (Extra) Experimenta a variante Native AOT comentada no Dockerfile. Que problemas encontraste?

---

## Etapa 6 — Docker Compose (aplicação completa)

```bash
docker compose up --build
```

| URL | O quê |
|---|---|
| http://localhost:8080 | Frontend — login CPF `123.456.789-01`, senha `giropops` |
| http://localhost:8081/health/live | api-contas |
| http://localhost:8082/health/live | api-transacoes |
| http://localhost:8083/health/live | auditoria |

Testes:

1. **Bruno** — corre as 3 collections com o ambiente `local` **e** com o ambiente `web` (passa pelo nginx). Tudo verde.
2. **Browser** — abre conta nova, faz login, transfere para outra conta, confirma o extrato e o ecrã de auditoria.
3. **Resiliência**:
   ```bash
   docker compose stop auditoria         # transferências continuam a funcionar (201)
   docker compose logs api-transacoes    # warning "auditoria indisponivel"
   docker compose start auditoria
   docker compose stop postgres          # /health/ready das APIs → 503
   docker compose start postgres
   ```
4. **Sidecar** — `docker compose logs -f log-forwarder` mostra as linhas do ficheiro de log da api-transacoes.
5. **Hardening** — o compose corre as APIs com `read_only: true` e `cap_drop: ALL`. Se a tua API escrever fora de `/tmp`, `/data` ou `/var/log/app`, vai falhar aqui (e no k8s).

---

## Etapa 7 — Kubernetes

### 7.1 Cluster e imagens

Com **kind** (exemplo):

```bash
kind create cluster --name tipsbank
# carregar as imagens locais no cluster (sem registry)
for i in api-contas api-transacoes auditoria web; do
  kind load docker-image tipsbank-$i:v1.0.0 --name tipsbank
done
```

Ou publica num registry (GHCR, Docker Hub, registry da Academia):

```bash
REGISTRY=ghcr.io/<o-teu-user>
for i in api-contas api-transacoes auditoria web; do
  docker tag tipsbank-$i:v1.0.0 $REGISTRY/tipsbank-$i:v1.0.0
  docker push $REGISTRY/tipsbank-$i:v1.0.0
done
```

Substitui `REGISTRY/` nos manifests:

```bash
# kind (imagem local):            REGISTRY/tipsbank-x → tipsbank-x
sed -i 's#REGISTRY/##' k8s/0[5-9]-*.yaml
# registry remoto:
# sed -i "s#REGISTRY#$REGISTRY#" k8s/0[5-9]-*.yaml
```

### 7.2 Aplicar

```bash
kubectl apply -f k8s/            # ficheiros numerados = ordem de aplicação
kubectl get pods -A -l 'app in (postgres,api-contas,api-transacoes,auditoria,web)' -w
```

Todos os pods devem chegar a `Running` e `READY` (a api-transacoes tem `2/2`: API + sidecar).

### 7.3 Aceder

```bash
kubectl port-forward -n tipsbank-web svc/web 8080:8080
# http://localhost:8080  e as collections Bruno com o ambiente "web"
```

Com LoadBalancer (MetalLB / cloud): `kubectl get svc -n tipsbank-web web`, aponta `tipsbank.local` para o
`EXTERNAL-IP` no `/etc/hosts` e usa o ambiente Bruno `k8s`.

### 7.4 Verificações obrigatórias

```bash
# probes a funcionar (sem restarts)
kubectl get pods -A | grep tipsbank

# logs JSON
kubectl logs -n tipsbank-contas deploy/api-contas | head
kubectl logs -n tipsbank-transacoes deploy/api-transacoes -c log-forwarder | head

# ficheiros da auditoria no PVC
kubectl run -n tipsbank-auditoria ls-data --rm -it --restart=Never --image=busybox:1.36.1-musl \
  --overrides='{"spec":{"securityContext":{"runAsUser":1654},"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"pvc-tipsbank-auditoria"}}],"containers":[{"name":"ls","image":"busybox:1.36.1-musl","command":["ls","-l","/data"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}]}}'

# readiness reage à BD
kubectl scale -n tipsbank-contas sts/postgres --replicas=0
kubectl get pods -n tipsbank-contas -w      # api-contas passa a 0/1 READY
kubectl scale -n tipsbank-contas sts/postgres --replicas=1

# rollout de uma nova versão
kubectl set env -n tipsbank-transacoes deploy/api-transacoes APP_VERSION=v2
curl -si http://localhost:8080/api/transacoes/health/live | grep -i x-app-version
kubectl rollout undo -n tipsbank-transacoes deploy/api-transacoes
```

### 7.5 Desafios extra (opcionais, valorizados)

- **HPA** na api-transacoes por CPU (precisa do metrics-server) e teste de carga.
- **NetworkPolicy** *default-deny* por namespace + regras que permitam só a cadeia `web → transacoes → contas` e `transacoes → auditoria`.
- **Ingress** com host `tipsbank.local` em vez do Service LoadBalancer.
- **Auditoria com 3 réplicas** sobre um PVC `ReadWriteMany` (NFS).
- **Testes automáticos** (xUnit + `WebApplicationFactory` + Testcontainers PostgreSQL).
- **Pipeline CI** (GitHub Actions/GitLab CI): build, testes, Trivy, push.
- **Native AOT** em pelo menos um serviço.

---

## Etapa 8 — Entrega

Entrega um repositório Git com:

1. O código em `*/src/` das três APIs.
2. Os Dockerfiles (podes alterar os de exemplo; explica porquê).
3. O `docker-compose.yml` e a pasta `k8s/` ajustados ao teu ambiente.
4. Um `ENTREGA.md` com:
   - respostas às perguntas das etapas 0 e 5;
   - bibliotecas usadas e porquê;
   - output do Bruno Runner (3 collections, ambiente `web`) — print ou `bru run --reporter-html`;
   - output do `trivy image` das três imagens;
   - `kubectl get pods,svc,pvc -A | grep tipsbank`;
   - tabela de tamanhos das imagens (.NET vs Python original);
   - problemas encontrados e como os resolveste.

### Critérios de avaliação

| Critério | Peso |
|---|---|
| Contrato respeitado — collections Bruno 100% verdes e frontend funcional | 30% |
| Regras de negócio (compensação, `FOR UPDATE`, bcrypt, auditoria best-effort, append JSONL) | 20% |
| Imagens: multi-stage, chiseled/não-root, 0 HIGH/CRITICAL, tags versionadas | 15% |
| Docker Compose: tudo arranca com `docker compose up --build`, testes de resiliência | 10% |
| Kubernetes: pods Ready, probes, securityContext, PVC, sidecar, rollout/rollback | 15% |
| Qualidade: código legível, configuração por variáveis de ambiente, logs JSON, métricas, `ENTREGA.md` | 10% |

### Checklist final

- [ ] `docker compose up --build` arranca tudo sem erros.
- [ ] Login no frontend com `123.456.789-01` / `giropops`.
- [ ] Abrir conta, transferir, ver extrato e eventos de auditoria pelo frontend.
- [ ] 3 collections Bruno verdes (`local` e `web`).
- [ ] `trivy` sem HIGH/CRITICAL nas 3 imagens.
- [ ] Nenhum container corre como root; nenhum usa `:latest`.
- [ ] `kubectl apply -f k8s/` → todos os pods `Ready`, sem restarts.
- [ ] Frontend acessível no cluster e collections verdes no cluster.
- [ ] `ENTREGA.md` completo.

---

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `400` em `POST /contas` vindo do frontend | Falta `JsonNumberHandling.AllowReadingFromString` (`saldo_inicial` chega como string) |
| Campos `null` / ignorados no body | Falta `JsonNamingPolicy.SnakeCaseLower` |
| Frontend mostra "HTTP 4xx" em vez da mensagem | O erro não tem campo `detail` |
| Login seed falha | Não removeste a pontuação do CPF, ou a biblioteca bcrypt não aceita `$2b$` |
| `relation "Contas" does not exist` | EF Core está a usar PascalCase — mapeia para `contas` / snake_case |
| `UnauthorizedAccessException` em `/data` ou `/var/log/app` | Volume não é do UID 1654 (init container / `fsGroup`) |
| `Read-only file system` | A aplicação escreve fora de `/tmp`/volumes (ex.: cache, Data Protection keys) |
| API não responde no container | Não está a escutar em `0.0.0.0:8080` — confirma `ASPNETCORE_HTTP_PORTS` e não forces `--urls localhost` |
| `150,75` em vez de `150.75` | Cultura do sistema — usa `CultureInfo.InvariantCulture` |
| Pod `CrashLoopBackOff` sem logs úteis | `kubectl logs --previous`, `kubectl describe pod`; não há shell para `exec` → `kubectl debug` |
