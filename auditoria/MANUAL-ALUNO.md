# auditoria — Manual do Aluno

> Microserviço que recebe **eventos de negócio** (ex.: cada transferência) e grava-os em ficheiros
> **JSONL** num volume persistente (NFS/PVC em Kubernetes). Não usa base de dados.
> Vais reescrevê-lo em **.NET 10** mantendo **exatamente** o contrato HTTP descrito aqui.

- Especificação completa: [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1)
- Collection de testes: [`bruno/`](bruno/)
- Dockerfile de exemplo: [`Dockerfile`](Dockerfile)
- Visão global: [`../docs/arquitetura.md`](../docs/arquitetura.md)

---

## 1. Responsabilidade

| Faz | Não faz |
|---|---|
| Acrescentar eventos a `eventos-YYYY-MM-DD.jsonl` | Usar base de dados |
| Listar eventos de um dia (só leitura) | Alterar/apagar eventos (é append-only) |
| Listar os ficheiros existentes | Chamar outros serviços |
| Verificar se o volume é gravável (readiness) | |

**Quem o chama:** a `api-transacoes` (`POST /eventos` após cada transferência) e o frontend `web` (ecrã de auditoria: `GET /arquivos` e `GET /eventos`).

---

## 2. Configuração

| Variável | Exemplo | Descrição |
|---|---|---|
| `DATA_DIR` | `/data` | Diretório dos ficheiros JSONL (volume). Criar se não existir, no arranque. |
| `LOG_LEVEL` | `INFO` | Nível de log |
| `ASPNETCORE_HTTP_PORTS` | `8080` | Definida no Dockerfile |

---

## 3. Formato em disco

- Um ficheiro por dia **em UTC**: `${DATA_DIR}/eventos-2026-10-24.jsonl`.
- Uma linha JSON por evento, terminada em `\n`, UTF-8 sem escapar acentos.
- Ficheiro aberto em modo **append** — nunca reescrever o ficheiro inteiro.

Exemplo de conteúdo:

```jsonl
{"id":"9c0e1f2a-3b4c-4d5e-8f60-718293a4b5c6","recebido_em":"2026-10-24T10:15:30.123456+00:00","tipo":"transferencia","transacao_id":"3b2f6a10-55c1-4e0f-8a39-9f4a1c7e2d11","origem_id":"11111111-1111-1111-1111-111111111111","destino_id":"22222222-2222-2222-2222-222222222222","valor":"150.75","versao_app":"v1"}
{"id":"5a6b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0d","recebido_em":"2026-10-24T10:16:02.004211+00:00","tipo":"login","transacao_id":null,"origem_id":null,"destino_id":null,"valor":null,"versao_app":null}
```

> Com **várias réplicas** a escrever no mesmo ficheiro NFS (`ReadWriteMany`), cada evento deve ser escrito
> numa única operação de escrita (linha completa + `\n`) para não intercalar linhas. Em .NET:
> `File.AppendAllTextAsync(path, linha + "\n")` ou um `FileStream` com `FileMode.Append` e um único `WriteAsync`.

---

## 4. Endpoints

| Método | Rota | Sucesso | Erros | Descrição |
|---|---|---|---|---|
| GET | `/health/live` | 200 `{"status":"ok"}` | — | Liveness |
| GET | `/health/ready` | 200 `{"status":"ready"}` | 503 | `DATA_DIR` existe e é gravável |
| GET | `/health/startup` | 200 `{"status":"started","data_dir":"/data"}` | — | Startup |
| GET | `/metrics` | 200 `text/plain` | — | Prometheus (recalcula o gauge de bytes) |
| POST | `/eventos` | 201 `EventoRegistado` | 400/422, 500 | Registar evento |
| GET | `/eventos?dia=YYYY-MM-DD&limit=100` | 200 `EventoRegistado[]` | — | Últimas N linhas (máx. 500) |
| GET | `/arquivos` | 200 `string[]` | — | Ficheiros `eventos-*.jsonl` ordenados |

### 4.1 Excerto OpenAPI — schemas

```yaml
components:
  schemas:
    Evento:
      type: object
      required: [tipo]
      properties:
        tipo:         { type: string, minLength: 3 }
        transacao_id: { type: [string, "null"] }
        origem_id:    { type: [string, "null"] }
        destino_id:   { type: [string, "null"] }
        valor:        { type: [string, "null"] }   # texto, ex. "150.75"
        versao_app:   { type: [string, "null"] }

    EventoRegistado:
      allOf:
        - type: object
          required: [id, recebido_em]
          properties:
            id:          { type: string, format: uuid }
            recebido_em: { type: string, format: date-time }   # ISO-8601 UTC
        - $ref: "#/components/schemas/Evento"
```

### 4.2 Excerto OpenAPI — `GET /eventos`

```yaml
  /eventos:
    get:
      summary: Listar eventos de um dia
      parameters:
        - name: dia
          in: query
          description: YYYY-MM-DD; omitido = hoje (UTC)
          schema: { type: string, format: date }
        - name: limit
          in: query
          description: últimas N linhas; acima de 500 → 500
          schema: { type: integer, default: 100 }
      responses:
        "200":
          description: Eventos pela ordem de gravação (ficheiro inexistente → [])
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/EventoRegistado" }
```

---

## 5. Exemplos de pedidos

### Registar evento

```bash
curl -s -X POST http://localhost:8083/eventos \
  -H 'content-type: application/json' \
  -d '{"tipo":"transferencia","transacao_id":"3b2f6a10-55c1-4e0f-8a39-9f4a1c7e2d11","origem_id":"11111111-1111-1111-1111-111111111111","destino_id":"22222222-2222-2222-2222-222222222222","valor":"150.75","versao_app":"v1"}'
```
```http
HTTP/1.1 201 Created

{"id":"9c0e1f2a-3b4c-4d5e-8f60-718293a4b5c6","recebido_em":"2026-10-24T10:15:30.123456+00:00","tipo":"transferencia","transacao_id":"3b2f6a10-55c1-4e0f-8a39-9f4a1c7e2d11","origem_id":"11111111-1111-1111-1111-111111111111","destino_id":"22222222-2222-2222-2222-222222222222","valor":"150.75","versao_app":"v1"}
```

Evento só com o campo obrigatório — os restantes ficam `null`:
```bash
curl -s -X POST http://localhost:8083/eventos -H 'content-type: application/json' -d '{"tipo":"login"}'
# {"id":"...","recebido_em":"...","tipo":"login","transacao_id":null,"origem_id":null,"destino_id":null,"valor":null,"versao_app":null}
```

`tipo` com menos de 3 caracteres → 400/422.

### Consultas

```bash
curl -s http://localhost:8083/eventos                         # hoje, últimas 100
curl -s 'http://localhost:8083/eventos?dia=2026-10-24&limit=5'
curl -s 'http://localhost:8083/eventos?dia=1999-01-01'        # []
curl -s http://localhost:8083/arquivos                        # ["eventos-2026-10-24.jsonl"]
```

### Health e métricas

```bash
curl -s http://localhost:8083/health/startup    # {"status":"started","data_dir":"/data"}
curl -s -i http://localhost:8083/health/ready   # 503 {"detail":"DATA_DIR nao gravavel"} se o volume for read-only
curl -s http://localhost:8083/metrics | grep auditoria_
```

---

## 6. Regras de negócio

1. **Arranque**: `Directory.CreateDirectory(DATA_DIR)`.
2. **`POST /eventos`**
   - Valida `tipo` (mín. 3 caracteres).
   - Constrói o registo: `id` (UUID v4) + `recebido_em` (`DateTimeOffset.UtcNow`, ISO-8601) + **todos** os campos de `Evento` (null quando ausentes).
   - Append ao ficheiro do dia. `IOException` → 500 `{"detail":"falha ao persistir evento"}` + log `ERROR`.
   - `auditoria_eventos_total{tipo=<tipo>}++`; log `INFO` `evento registado id=<id> tipo=<tipo>`.
   - Responde 201 com o registo gravado.
3. **`GET /eventos`**: ficheiro do `dia` (ou de hoje UTC); devolve as últimas `min(limit, 500)` linhas não vazias, já desserializadas, pela ordem do ficheiro. Ficheiro inexistente → `[]`.
4. **`GET /arquivos`**: nomes (sem caminho) dos `eventos-*.jsonl`, ordenados alfabeticamente.
5. **`GET /health/ready`**: 503 `DATA_DIR nao gravavel` se o diretório não existir ou não for gravável (testa criando e apagando um ficheiro temporário, por exemplo).
6. **`GET /metrics`**: antes de responder, soma o tamanho de todos os `eventos-*.jsonl` no gauge `auditoria_arquivo_bytes`.

> **Segurança:** valida `dia` com o padrão `^\d{4}-\d{2}-\d{2}$` antes de construir o caminho — impede *path traversal*
> (`?dia=../../etc/passwd`). A versão Python original não o faz; é uma melhoria esperada.

---

## 7. Compatibilidade ⚠️

| Armadilha | Solução em .NET |
|---|---|
| snake_case (`transacao_id`, `recebido_em`, `versao_app`, `data_dir`). | `JsonNamingPolicy.SnakeCaseLower` |
| Campos opcionais têm de aparecer como `null` (não omitidos). | Não usar `JsonIgnoreCondition.WhenWritingNull`. |
| `valor` é **string** neste serviço. | Tipar como `string?`, não `decimal`. |
| Acentos legíveis no ficheiro (`"Estagiário"`, não `\u00E1`). | `Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping` ao gravar. |
| Data do ficheiro em UTC. | `DateTime.UtcNow.ToString("yyyy-MM-dd")`. |
| Frontend lê `body.detail`. | `Results.Problem(...)`. |

---

## 8. Observabilidade

Logs JSON numa linha em stdout:
```json
{"ts":"2026-10-24 10:15:30,123","level":"INFO","service":"auditoria","msg":"evento registado id=9c0e... tipo=transferencia"}
```

| Métrica | Tipo | Labels |
|---|---|---|
| `auditoria_eventos_total` | counter | `tipo` |
| `auditoria_arquivo_bytes` | gauge | — |

---

## 9. Requisitos do container

- Porta 8080, não-root (UID 1654), root filesystem só de leitura.
- `DATA_DIR=/data` montado como volume **gravável pelo UID 1654**:
  - compose: init container `busybox` faz `chown 1654:1654 /data` antes do arranque;
  - Kubernetes: `securityContext.fsGroup: 1654` no pod (ou initContainer, se o NFS não suportar `fsGroup`).
- Várias réplicas partilham o mesmo PVC `ReadWriteMany`.

---

## 10. Testar com o Bruno

1. **Open Collection** → `auditoria/bruno`; ambiente `local`, `web` ou `k8s`.
2. **Run** a collection: `02 Eventos` regista dois eventos, verifica que aparecem na listagem, que `limit=1` devolve o último, que um dia sem ficheiro devolve `[]` e que `/arquivos` contém o ficheiro de hoje.
3. Confirma no volume: `docker compose exec` não funciona (imagem sem shell!) — usa
   `docker run --rm -v tipsbank_auditdata:/data busybox tail -n 3 /data/eventos-$(date -u +%F).jsonl`.

---

## 11. Checklist de aceitação

- [ ] Projeto `src/Auditoria/Auditoria.csproj` em .NET 10.
- [ ] Formato JSONL idêntico (campos, nulls, UTC, um ficheiro por dia).
- [ ] Escrita em append, segura com várias réplicas.
- [ ] `dia` validado contra *path traversal*.
- [ ] `/health/ready` devolve 503 com o volume em modo read-only (`docker run ... -v x:/data:ro`).
- [ ] `/metrics` com `auditoria_eventos_total` e `auditoria_arquivo_bytes`.
- [ ] Imagem multi-stage, não-root, sem HIGH/CRITICAL.
- [ ] Collection Bruno 100% verde.
