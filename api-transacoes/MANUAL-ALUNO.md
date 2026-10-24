# api-transacoes — Manual do Aluno

> Microserviço que executa **transferências** entre contas. Não mexe diretamente na tabela `contas`:
> orquestra a `api-contas` (débito + crédito), grava o registo da transação e publica um evento na `auditoria`.
> Vais reescrevê-lo em **.NET 10** mantendo **exatamente** o contrato HTTP descrito aqui.

- Especificação completa: [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1)
- Collection de testes: [`bruno/`](bruno/)
- Dockerfile de exemplo: [`Dockerfile`](Dockerfile)
- Visão global: [`../docs/arquitetura.md`](../docs/arquitetura.md)

---

## 1. Responsabilidade

```
web ──POST /transferencias──► api-transacoes ──POST /contas/{origem}/saldo  (debito)──► api-contas
                                     │        ──POST /contas/{destino}/saldo (credito)─► api-contas
                                     │        ──INSERT transacoes──────────────────────► PostgreSQL
                                     └────────POST /eventos (best-effort)──────────────► auditoria
```

| Faz | Não faz |
|---|---|
| Orquestrar débito/crédito com **compensação** | Alterar a tabela `contas` diretamente |
| Gravar a tabela `transacoes` | Validar senhas |
| Extrato por conta | Falhar a transferência se a auditoria estiver em baixo |
| Expor a versão (`X-App-Version`) para canary | |
| Escrever log também em ficheiro (sidecar) | |

---

## 2. Configuração

| Variável | Exemplo (compose) | Descrição |
|---|---|---|
| `ConnectionStrings__TipsBank` | `Host=postgres;Port=5432;Database=tipsbank;Username=tipsbank;Password=tipsbank` | Connection string Npgsql |
| `CONTAS_URL` | `http://api-contas:8080` | Base URL da api-contas |
| `AUDITORIA_URL` | `http://auditoria:8080` | Base URL da auditoria |
| `APP_VERSION` | `v1` | Devolvida em `/health/live` e no header `X-App-Version` |
| `LOG_LEVEL` | `INFO` | Nível de log |
| `LOG_FILE` *(opcional)* | `/var/log/app/app.log` | Caminho do ficheiro de log; útil para desenvolver fora do container (`./app.log`). |
| `ASPNETCORE_HTTP_PORTS` | `8080` | Definida no Dockerfile |

Em Kubernetes os URLs passam a FQDN, ex.: `http://api-contas.tipsbank-contas.svc.cluster.local:8080` (ver [`../k8s/03-configmap-app.yaml`](../k8s/03-configmap-app.yaml)).

---

## 3. Modelo de dados

Tabela `transacoes` (criada por [`../sql/init.sql`](../sql/init.sql)):

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `VARCHAR(64)` PK | UUID v4 |
| `origem_id` | `VARCHAR(64)` NOT NULL, indexado | |
| `destino_id` | `VARCHAR(64)` NOT NULL, indexado | |
| `valor` | `NUMERIC(15,2)` NOT NULL | `decimal` em C# |
| `status` | `VARCHAR(20)` NOT NULL | `concluida` |
| `criada_em` | `TIMESTAMP` DEFAULT NOW() | usado para ordenar o extrato |

---

## 4. Endpoints

| Método | Rota | Sucesso | Erros | Descrição |
|---|---|---|---|---|
| GET | `/health/live` | 200 `{"status":"ok","version":"v1"}` | — | Liveness + versão |
| GET | `/health/ready` | 200 `{"status":"ready"}` | 503 | `SELECT now()` na BD |
| GET | `/health/startup` | 200 `{"status":"started"}` | — | Startup |
| GET | `/metrics` | 200 `text/plain` | — | Prometheus |
| POST | `/transferencias` | 201 `TransacaoOut` | 404/422 (propagado), 400/422 | Transferir |
| GET | `/transferencias/{tx_id}` | 200 `TransacaoOut` | 404 | Obter transação |
| GET | `/extrato/{conta_id}?limit=20` | 200 `TransacaoOut[]` | — | Extrato (máx. 100) |
| GET | `/pix?limit=20` | 200 `PixOut[]` | — | Mock (máx. 20) |

**Todas** as respostas levam o header `X-App-Version: <APP_VERSION>`.

### 4.1 Excerto OpenAPI — schemas

```yaml
components:
  schemas:
    TransferenciaIn:
      type: object
      required: [origem_id, destino_id, valor]
      properties:
        origem_id:  { type: string }
        destino_id: { type: string }
        valor:      { $ref: "#/components/schemas/Decimal" }   # > 0

    TransacaoOut:
      type: object
      required: [id, origem_id, destino_id, valor, status]
      properties:
        id:         { type: string, format: uuid }
        origem_id:  { type: string }
        destino_id: { type: string }
        valor:      { $ref: "#/components/schemas/Decimal" }
        status:     { type: string, example: concluida }

    PixOut:      # mesma forma que TransacaoOut, status = "concluido"
      $ref: "#/components/schemas/TransacaoOut"

    Decimal:
      oneOf: [ { type: number }, { type: string, pattern: '^-?\d+(\.\d+)?$' } ]
```

### 4.2 Excerto OpenAPI — `POST /transferencias`

```yaml
  /transferencias:
    post:
      summary: Executar transferência
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/TransferenciaIn" }
            example:
              origem_id: 11111111-1111-1111-1111-111111111111
              destino_id: 22222222-2222-2222-2222-222222222222
              valor: "150.75"
      responses:
        "201":
          description: Transferência concluída
          headers:
            X-App-Version: { schema: { type: string } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/TransacaoOut" }
        "404": { description: 'Conta inexistente — detail "debito falhou: ..." ou "credito falhou: ..."' }
        "422": { description: 'Saldo insuficiente — detail "debito falhou: {\"detail\":\"saldo insuficiente\"}"' }
```

---

## 5. Algoritmo da transferência (obrigatório)

```
1. tx_id = novo UUID v4
2. log INFO "transferencia id=<tx_id> origem=<o> destino=<d> valor=<v>"
3. POST {CONTAS_URL}/contas/{origem_id}/saldo  {"valor":"<v>","operacao":"debito"}   (timeout 5 s)
     ≠ 200 → transacoes_total{status="falha_debito"}++
             responder com O MESMO status recebido, detail = "debito falhou: <corpo recebido>"
4. POST {CONTAS_URL}/contas/{destino_id}/saldo {"valor":"<v>","operacao":"credito"}
     ≠ 200 → COMPENSAÇÃO: POST .../contas/{origem_id}/saldo {"operacao":"credito"}
             transacoes_total{status="falha_credito"}++
             responder com o status recebido, detail = "credito falhou: <corpo recebido>"
5. INSERT em transacoes (status = "concluida")
6. POST {AUDITORIA_URL}/eventos (timeout 3 s) — se falhar: log WARNING "auditoria indisponivel: ..." e CONTINUAR
     {"tipo":"transferencia","transacao_id":..,"origem_id":..,"destino_id":..,"valor":"<v>","versao_app":APP_VERSION}
7. transacoes_total{status="ok"}++  → 201 TransacaoOut
```

Pontos de atenção:
- Usa `IHttpClientFactory` (`builder.Services.AddHttpClient("contas", c => { c.BaseAddress = ...; c.Timeout = TimeSpan.FromSeconds(5); })`). Não cries `new HttpClient()` por pedido.
- Envia `valor` como **string** para a api-contas e para a auditoria (é o que o contrato da auditoria espera: `valor` é texto). Usa `valor.ToString(CultureInfo.InvariantCulture)` — **nunca** a cultura atual (`150,75` parte tudo).
- A compensação é uma *saga* simplificada; discute no relatório o que acontece se a própria compensação falhar.
- Mesmo que o timeout da auditoria dispare, o cliente recebe 201.

---

## 6. Exemplos de pedidos

### Transferência com sucesso

```bash
curl -s -i -X POST http://localhost:8082/transferencias \
  -H 'content-type: application/json' \
  -d '{"origem_id":"11111111-1111-1111-1111-111111111111","destino_id":"22222222-2222-2222-2222-222222222222","valor":"150.75"}'
```
```http
HTTP/1.1 201 Created
content-type: application/json
x-app-version: v1

{"id":"3b2f6a10-55c1-4e0f-8a39-9f4a1c7e2d11","origem_id":"11111111-1111-1111-1111-111111111111","destino_id":"22222222-2222-2222-2222-222222222222","valor":150.75,"status":"concluida"}
```

### Saldo insuficiente (propagado da api-contas)

```bash
curl -s -i -X POST http://localhost:8082/transferencias \
  -H 'content-type: application/json' \
  -d '{"origem_id":"22222222-2222-2222-2222-222222222222","destino_id":"11111111-1111-1111-1111-111111111111","valor":"999999"}'
```
```http
HTTP/1.1 422 Unprocessable Entity

{"detail":"debito falhou: {\"detail\":\"saldo insuficiente\"}"}
```

### Destino inexistente (com compensação)

```bash
curl -s -i -X POST http://localhost:8082/transferencias \
  -H 'content-type: application/json' \
  -d '{"origem_id":"11111111-1111-1111-1111-111111111111","destino_id":"00000000-0000-0000-0000-000000000000","valor":"5"}'
# HTTP/1.1 404  {"detail":"credito falhou: {\"detail\":\"conta nao encontrada\"}"}
# O saldo da origem fica igual ao que estava antes (débito foi revertido).
```

### Consultas

```bash
curl -s http://localhost:8082/transferencias/3b2f6a10-55c1-4e0f-8a39-9f4a1c7e2d11
curl -s 'http://localhost:8082/extrato/11111111-1111-1111-1111-111111111111?limit=5'   # mais recente primeiro
curl -s 'http://localhost:8082/pix?limit=3'
curl -s -i http://localhost:8082/health/live    # {"status":"ok","version":"v1"} + header x-app-version
```

---

## 7. Compatibilidade ⚠️

| Armadilha | Solução em .NET |
|---|---|
| O frontend envia `valor` como string (`"150.75"`). | `JsonNumberHandling.AllowReadingFromString` |
| snake_case nos campos. | `JsonNamingPolicy.SnakeCaseLower` |
| Frontend lê `body.detail`. | `Results.Problem(detail: ..., statusCode: ...)` |
| `valor` tem de ser > 0. | Validar e devolver 400/422. |
| Cultura do container. | Formatar/parsing com `CultureInfo.InvariantCulture`. Considera `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`. |
| Ordem do extrato. | `ORDER BY criada_em DESC LIMIT min(limit,100)` com `WHERE origem_id = @id OR destino_id = @id`. |
| Header de versão em todas as respostas. | Middleware: `app.Use(async (ctx, next) => { ctx.Response.Headers["X-App-Version"] = version; await next(); });` |

---

## 8. Logs em ficheiro + sidecar

Para além de stdout, a API **tem de** escrever as mesmas linhas JSON em `/var/log/app/app.log`.
Um segundo container (*sidecar* `log-forwarder`, `busybox` com `tail -F /var/log/app/app.log`) partilha esse diretório e reencaminha o log.

- No compose e no k8s, `/var/log/app` é um volume partilhado (named volume / `emptyDir`) gravável pelo UID 1654.
- A primeira linha deve ser escrita **no arranque** (ex.: `bootstrap versao=v1`) — o sidecar usa a existência do ficheiro nas probes.
- Se não conseguir criar o ficheiro, regista um warning e continua só com stdout.

Exemplo de linha:
```json
{"ts":"2026-10-24 10:15:30,123","level":"INFO","service":"api-transacoes","msg":"bootstrap versao=v1"}
```

Sugestão: Serilog com dois sinks (`Console` + `File`) e o mesmo formatter JSON.

---

## 9. Métricas

| Métrica | Tipo | Labels |
|---|---|---|
| `http_requests_total` | counter | `method`, `path`, `status` |
| `http_request_duration_seconds` | histogram | `path` |
| `transacoes_total` | counter | `status` = `ok` \| `falha_debito` \| `falha_credito` |

---

## 10. Requisitos do container

- Porta 8080, não-root (UID 1654), root filesystem só de leitura (exceto `/tmp` e `/var/log/app`).
- `APP_VERSION` sobreponível por variável de ambiente (usado para demonstrar *canary*: v1 vs v2).
- Sem `:latest`; 0 HIGH/CRITICAL no Trivy.

---

## 11. Testar com o Bruno

1. **Open Collection** → `api-transacoes/bruno`. Esta collection precisa das 3 APIs a correr (usa `contasUrl` e `auditoriaUrl`).
2. Ambiente `local` (portas 8081/8082/8083), `web` (tudo via `http://localhost:8080/api/...`) ou `k8s`.
3. **Run** a collection completa:
   - `02 Transferencias` faz uma transferência real de 10.00 da conta seed 1 para a seed 2 e guarda o `txId`.
   - `04 Erros` inclui o teste de **compensação** (lê o saldo, força falha no crédito, confirma que o saldo voltou ao valor inicial).
   - `05 Integracao auditoria` confirma que o evento da transferência chegou à auditoria.

---

## 12. Checklist de aceitação

- [ ] Projeto `src/ApiTransacoes/ApiTransacoes.csproj` em .NET 10.
- [ ] Algoritmo da secção 5 respeitado, incluindo compensação e propagação do status code.
- [ ] Auditoria em baixo **não** faz falhar a transferência (testa com `docker compose stop auditoria`).
- [ ] `X-App-Version` em todas as respostas; `/health/live` com `version`.
- [ ] Log JSON em stdout **e** em `/var/log/app/app.log`; sidecar mostra as linhas (`docker compose logs log-forwarder`).
- [ ] `IHttpClientFactory` com timeouts (5 s contas, 3 s auditoria).
- [ ] `/metrics` com `transacoes_total` por status.
- [ ] Imagem multi-stage, não-root, sem HIGH/CRITICAL.
- [ ] Collection Bruno 100% verde.
