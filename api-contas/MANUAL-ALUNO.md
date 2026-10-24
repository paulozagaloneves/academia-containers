# api-contas — Manual do Aluno

> Microserviço responsável pelas **contas bancárias** do TipsBank: criação, consulta, ajuste de saldo e autenticação.
>

- Especificação completa: [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1)
- Collection de testes: [`bruno/`](bruno/) (abrir no Bruno)
- Dockerfile de exemplo: [`Dockerfile`](Dockerfile)
- Visão global: [`../docs/arquitetura.md`](../docs/arquitetura.md)

---

## 1. Responsabilidade

| Faz                                       | Não faz                                          |
| ----------------------------------------- | ------------------------------------------------ |
| Criar contas com senha guardada em bcrypt | Transferências (é a `api-transacoes`)            |
| Autenticar titular (documento + senha)    | Emitir tokens/JWT (o "login" só devolve a conta) |
| Consultar conta(s)                        | Gravar auditoria                                 |
| Creditar/debitar saldo de forma atómica   | Chamar outros serviços                           |

**Quem o chama:** o frontend `web` (via proxy `/api/contas/`) e a `api-transacoes` (débito/crédito durante uma transferência).

**De quem depende:** apenas do PostgreSQL (tabela `contas`, criada por [`../sql/init.sql`](../sql/init.sql)).

---

## 2. Configuração

| Variável                      | Exemplo                                                                         | Descrição                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ConnectionStrings__TipsBank` | `Host=postgres;Port=5432;Database=tipsbank;Username=tipsbank;Password=tipsbank` | Connection string Npgsql. Em .NET lê-se com `builder.Configuration.GetConnectionString("TipsBank")`. |
| `LOG_LEVEL`                   | `INFO`                                                                          | `DEBUG`, `INFO`, `WARNING`, `ERROR`. Mapear para `Logging:LogLevel:Default`.                         |
| `ASPNETCORE_HTTP_PORTS`       | `8080`                                                                          | Já definida no Dockerfile. **A porta tem de ser 8080.**                                              |

> A versão Python usava `DB_URL=postgresql+psycopg://...`. Em .NET usamos a convenção `ConnectionStrings__<Nome>`; os manifests e o `docker-compose.yml` deste desafio já estão ajustados.

---

## 3. Modelo de dados

Tabela `contas` (já existe — **não** a recries com outro schema):

| Coluna       | Tipo                          | Notas                                         |
| ------------ | ----------------------------- | --------------------------------------------- |
| `id`         | `VARCHAR(64)` PK              | UUID v4 gerado pela API, guardado como texto  |
| `titular`    | `VARCHAR(120)` NOT NULL       |                                               |
| `documento`  | `VARCHAR(14)` NOT NULL UNIQUE | CPF só com dígitos                            |
| `senha_hash` | `VARCHAR(255)` NOT NULL       | hash bcrypt `$2b$10$...`                      |
| `saldo`      | `NUMERIC(15,2)` NOT NULL      | em C#: `decimal` (**nunca** `double`/`float`) |
| `criada_em`  | `TIMESTAMP` DEFAULT NOW()     | preenchido pela BD                            |

Contas seed (senha `giropops` em ambas):

| id                                     | titular           | documento     | saldo     |
| -------------------------------------- | ----------------- | ------------- | --------- |
| `11111111-1111-1111-1111-111111111111` | Jeferson Fernando | `12345678901` | 10 000.00 |
| `22222222-2222-2222-2222-222222222222` | LinuxTips SA      | `98765432100` | 500.00    |

---

## 4. Endpoints

| Método | Rota                       | Sucesso                    | Erros        | Descrição                |
| ------ | -------------------------- | -------------------------- | ------------ | ------------------------ |
| GET    | `/health/live`             | 200 `{"status":"ok"}`      | —            | Liveness                 |
| GET    | `/health/ready`            | 200 `{"status":"ready"}`   | 503          | Faz `SELECT now()` na BD |
| GET    | `/health/startup`          | 200 `{"status":"started"}` | —            | Startup probe            |
| GET    | `/metrics`                 | 200 `text/plain`           | —            | Métricas Prometheus      |
| POST   | `/contas`                  | 201 `ContaOut`             | 409, 400/422 | Criar conta              |
| GET    | `/contas?limit=50`         | 200 `ContaOut[]`           | —            | Listar (máx. 200)        |
| GET    | `/contas/{conta_id}`       | 200 `ContaOut`             | 404          | Obter conta              |
| POST   | `/contas/{conta_id}/saldo` | 200 `ContaOut`             | 404, 422     | Crédito/débito           |
| POST   | `/login`                   | 200 `ContaOut`             | 401, 400/422 | Autenticar               |

### 4.1 Excerto OpenAPI — schemas

```yaml
components:
  schemas:
    ContaIn:
      type: object
      required: [titular, documento, senha]
      properties:
        titular:       { type: string, minLength: 3,  maxLength: 120 }
        documento:     { type: string, minLength: 11, maxLength: 14 }
        senha:         { type: string, minLength: 4,  maxLength: 72, writeOnly: true }
        saldo_inicial: { $ref: "#/components/schemas/Decimal", default: 0 }   # >= 0

    ContaOut:
      type: object
      required: [id, titular, documento, saldo]
      properties:
        id:        { type: string, format: uuid }
        titular:   { type: string }
        documento: { type: string }
        saldo:     { $ref: "#/components/schemas/Decimal" }

    AjusteSaldo:
      type: object
      required: [valor, operacao]
      properties:
        valor:    { $ref: "#/components/schemas/Decimal" }
        operacao: { type: string, enum: [credito, debito] }

    Decimal:            # aceitar número OU string numérica na entrada
      oneOf:
        - type: number
        - type: string
          pattern: '^-?\d+(\.\d+)?$'

    Erro:
      type: object
      required: [detail]
      properties:
        detail: { type: string }
```

### 4.2 Excerto OpenAPI — `POST /contas/{conta_id}/saldo`

```yaml
  /contas/{conta_id}/saldo:
    post:
      summary: Ajustar saldo (crédito ou débito)
      parameters:
        - { name: conta_id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/AjusteSaldo" }
            example: { valor: "50.00", operacao: credito }
      responses:
        "200": { description: Saldo atualizado, content: { application/json: { schema: { $ref: "#/components/schemas/ContaOut" } } } }
        "404": { description: conta nao encontrada }
        "422": { description: saldo insuficiente }
```

---

## 5. Exemplos de pedidos

Os exemplos usam acesso direto (`localhost:8081`). Pelo frontend, troca por `http://localhost:8080/api/contas`.

### Criar conta

```bash
curl -s -X POST http://localhost:8081/contas \
  -H 'content-type: application/json' \
  -d '{"titular":"Maria Estagiária","documento":"11122233344","senha":"segredo123","saldo_inicial":"1000"}'
```

```http
HTTP/1.1 201 Created
content-type: application/json

{"id":"6f1c1d1e-7a2b-4c3d-9e8f-0a1b2c3d4e5f","titular":"Maria Estagiária","documento":"11122233344","saldo":1000.00}
```

Repetir o mesmo `documento`:
```http
HTTP/1.1 409 Conflict

{"detail":"documento ja cadastrado"}
```

### Login (CPF com pontuação)

```bash
curl -s -X POST http://localhost:8081/login \
  -H 'content-type: application/json' \
  -d '{"documento":"123.456.789-01","senha":"giropops"}'
```

```json
{"id":"11111111-1111-1111-1111-111111111111","titular":"Jeferson Fernando","documento":"12345678901","saldo":10000.00}
```

Senha errada **ou** documento inexistente (mesma resposta, de propósito):
```http
HTTP/1.1 401 Unauthorized

{"detail":"credenciais invalidas"}
```

### Listar e obter

```bash
curl -s 'http://localhost:8081/contas?limit=2'
curl -s http://localhost:8081/contas/22222222-2222-2222-2222-222222222222
curl -s -i http://localhost:8081/contas/00000000-0000-0000-0000-000000000000   # 404 {"detail":"conta nao encontrada"}
```

### Crédito e débito

```bash
# crédito com valor em string (é assim que a api-transacoes envia)
curl -s -X POST http://localhost:8081/contas/22222222-2222-2222-2222-222222222222/saldo \
  -H 'content-type: application/json' -d '{"valor":"50.00","operacao":"credito"}'
# -> {"id":"2222...","titular":"LinuxTips SA","documento":"98765432100","saldo":550.00}

# débito superior ao saldo
curl -s -i -X POST http://localhost:8081/contas/22222222-2222-2222-2222-222222222222/saldo \
  -H 'content-type: application/json' -d '{"valor":999999,"operacao":"debito"}'
# -> HTTP/1.1 422  {"detail":"saldo insuficiente"}
```

### Health e métricas

```bash
curl -s http://localhost:8081/health/live      # {"status":"ok"}
curl -s http://localhost:8081/health/ready     # {"status":"ready"}  (503 se a BD estiver em baixo)
curl -s http://localhost:8081/metrics | grep tipsbank_login_total
```

---

## 6. Regras de negócio

1. **`POST /contas`**
   - Valida tamanhos (titular 3–120, documento 11–14, senha 4–72) e `saldo_inicial >= 0`.
   - Se já existir conta com o mesmo `documento` → 409 `documento ja cadastrado`.
   - Gera `id = Guid.NewGuid().ToString()`; guarda `senha_hash = BCrypt.HashPassword(senha, workFactor: 10)`.
   - Log `INFO`: `conta criada id=<id> titular=<titular>`.
2. **`POST /login`**
   - Remove tudo o que não é dígito do `documento` antes de pesquisar.
   - Conta inexistente ou senha que não confere → 401 + `tipsbank_login_total{status="falhou"}` + log `WARNING` com o documento mascarado (`123***`). **Nunca** registes a senha.
   - Sucesso → 200 + `tipsbank_login_total{status="ok"}`.
3. **`GET /contas`**: `limit` por omissão 50, máximo efetivo 200.
4. **`POST /contas/{id}/saldo`**
   - Dentro de **uma transação de BD**, lê a conta com bloqueio (`SELECT ... FOR UPDATE`), aplica a operação e faz commit.
   - `debito` com `saldo < valor` → 422 `saldo insuficiente`, sem alterar nada.
   - Devolve a conta já com o novo saldo.
5. **`ContaOut` nunca inclui** `senha`, `senha_hash` nem `criada_em`.

---

## 7. Compatibilidade com o frontend e com a api-transacoes ⚠️

Estes detalhes partem a aplicação se forem ignorados:

| Armadilha                                                                                                                                                                | Solução em .NET                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O frontend envia `saldo_inicial` como **string** (`"1000"`) e a api-transacoes envia `valor` como **string** (`"50.00"`). Por omissão o `System.Text.Json` rejeita isto. | `options.SerializerOptions.NumberHandling = JsonNumberHandling.AllowReadingFromString`                                                                                                          |
| Os campos são **snake_case** (`saldo_inicial`, `conta_id`).                                                                                                              | `options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower` (ou `[JsonPropertyName]`)                                                                                    |
| O frontend mostra `body.detail` nos erros.                                                                                                                               | Devolver `ProblemDetails` / `Results.Problem(detail: "...", statusCode: ...)` — o campo chama-se `detail`.                                                                                      |
| Erros de validação: o FastAPI devolve 422.                                                                                                                               | 400 (`ValidationProblem`) ou 422 são ambos aceites.                                                                                                                                             |
| Hashes seed são bcrypt `$2b$10$...` gerados em Python.                                                                                                                   | `BCrypt.Net-Next` (`BCrypt.Net.BCrypt.Verify`) aceita `$2b$`.                                                                                                                                   |
| Tabelas já criadas pelo `init.sql`.                                                                                                                                      | Mapear `contas`/colunas em snake_case (EF Core: `UseSnakeCaseNamingConvention()` do pacote `EFCore.NamingConventions`, ou `ToTable`/`HasColumnName`). Não uses migrations que alterem o schema. |
| `saldo` é `NUMERIC(15,2)`.                                                                                                                                               | `decimal` em C#; na resposta, número JSON (ex. `1000.00` ou `1000`).                                                                                                                            |

Exemplo de configuração JSON (Minimal API):

```csharp
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
    o.SerializerOptions.NumberHandling = JsonNumberHandling.AllowReadingFromString;
});
```

---

## 8. Observabilidade

**Logs** — uma linha JSON por evento em stdout:

```json
{"ts":"2026-10-24 10:15:30,123","level":"INFO","service":"api-contas","msg":"conta criada id=6f1c... titular=Maria"}
```

Sugestão: `builder.Logging.AddJsonConsole()` com um formatter próprio, ou Serilog com `CompactJsonFormatter`. O essencial é JSON numa linha e o campo `service`.

**Métricas** (`/metrics`, formato Prometheus — sugestão: `prometheus-net.AspNetCore`):

| Métrica                         | Tipo      | Labels                     |
| ------------------------------- | --------- | -------------------------- |
| `http_requests_total`           | counter   | `method`, `path`, `status` |
| `http_request_duration_seconds` | histogram | `path`                     |
| `tipsbank_login_total`          | counter   | `status` = `ok` \          | `falhou` |

---

## 9. Requisitos do container

- Porta **8080**, utilizador **não-root** (imagem chiseled: UID 1654), sem shell na imagem final.
- Deve funcionar com **root filesystem só de leitura** (não escrevas em disco; `/tmp` é montado como tmpfs/emptyDir).
- Imagem multi-stage a partir de [`Dockerfile`](Dockerfile); a imagem final não pode ter vulnerabilidades HIGH/CRITICAL (`trivy image`).
- Tag explícita (nunca `:latest`), ex.: `tipsbank-api-contas:v1.0.0`.

---

## 10. Testar com o Bruno

1. Instala o [Bruno](https://www.usebruno.com/) → **Open Collection** → seleciona a pasta `api-contas/bruno`.
2. Escolhe o ambiente:
   - `local` → `http://localhost:8081` (container direto)
   - `web` → `http://localhost:8080/api/contas` (através do nginx)
   - `k8s` → `http://tipsbank.local:8080/api/contas` (ajusta o host ao teu cluster)
3. Clica com o botão direito na collection → **Run** (Runner). As pastas correm por ordem:

   `01 Health` → `02 Contas` (cria uma conta com CPF aleatório e reutiliza o `contaId`) → `03 Login` → `04 Erros` → `05 Observabilidade`.
4. Linha de comandos (opcional): `npx @usebruno/cli run --env local` dentro da pasta `bruno/`.

**Todos os testes devem passar** — é o critério de aceitação do contrato.

---

## 11. Checklist de aceitação

- [ ] Projeto `src/ApiContas/ApiContas.csproj` em .NET 10 compila com `dotnet build`.
- [ ] Todas as rotas da secção 4 implementadas com os mesmos códigos HTTP.
- [ ] Senha nunca devolvida nem registada em log; hash bcrypt custo 10.
- [ ] Login com as contas seed (`giropops`) funciona — com e sem pontuação no CPF.
- [ ] Débito concorrente seguro (`FOR UPDATE` dentro de transação).
- [ ] Aceita valores monetários em string e em número.
- [ ] `/health/ready` devolve 503 quando o Postgres está parado.
- [ ] `/metrics` com as 3 métricas acima.
- [ ] Imagem construída com o Dockerfile multi-stage, não-root, sem HIGH/CRITICAL no Trivy.
- [ ] Collection Bruno 100% verde nos ambientes `local` e `web`.