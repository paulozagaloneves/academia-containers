# Academia Containers — TipsBank em .NET 10

Desafio prático de containers e Kubernetes para estagiários.

O **TipsBank** é um banco digital fictício, criado pela [LinuxTips](https://linuxtips.io) para o curso
*Descomplicando Kubernetes*. A aplicação original tem três microserviços em Python/FastAPI, um frontend
nginx e PostgreSQL.

**A tua missão:** reescrever os três microserviços em **.NET 10** sem mudar o contrato. Depois, pôr a
aplicação a correr em **Docker Compose** e num cluster **Kubernetes**, com o frontend original a funcionar.

```
web (nginx) ──► api-transacoes ──► api-contas ──► PostgreSQL
                      │
                      └──────────► auditoria ──► volume (JSONL)
```

## Por onde começar

1. [`docs/arquitetura.md`](docs/arquitetura.md): componentes, fluxos, dados, imagens e Kubernetes.
2. [`docs/manual-aluno.md`](docs/manual-aluno.md): etapas do desafio, entrega e critérios de avaliação.
3. O manual de cada microserviço:

| Microserviço | Manual | OpenAPI | Collection Bruno | Dockerfile |
|---|---|---|---|---|
| api-contas | [MANUAL-ALUNO.md](api-contas/MANUAL-ALUNO.md) | [openapi.yaml](api-contas/openapi.yaml) | [bruno/](api-contas/bruno) | [Dockerfile](api-contas/Dockerfile) |
| api-transacoes | [MANUAL-ALUNO.md](api-transacoes/MANUAL-ALUNO.md) | [openapi.yaml](api-transacoes/openapi.yaml) | [bruno/](api-transacoes/bruno) | [Dockerfile](api-transacoes/Dockerfile) |
| auditoria | [MANUAL-ALUNO.md](auditoria/MANUAL-ALUNO.md) | [openapi.yaml](auditoria/openapi.yaml) | [bruno/](auditoria/bruno) | [Dockerfile](auditoria/Dockerfile) |

## Conteúdo

| Pasta/ficheiro | O quê | Podes alterar? |
|---|---|---|
| `web/` | Frontend SPA + nginx (proxy reverso `/api/*`) | ❌ |
| `sql/init.sql` | Schema e contas seed | ❌ |
| `*/openapi.yaml`, `*/bruno/` | Contrato e testes de aceitação | ❌ |
| `*/Dockerfile` | Dockerfile de exemplo (.NET 10, multi-stage, chiseled) | ✅ (justifica) |
| `*/src/` | **O teu código** (a criar) | ✅ |
| `docker-compose.yml` | Ambiente local completo | ✅ |
| `k8s/` | Manifests Kubernetes de exemplo | ✅ |

## Arranque rápido (quando o código existir)

```bash
docker compose up --build
# http://localhost:8080 — login CPF 123.456.789-01, senha giropops

kubectl apply -f k8s/
kubectl port-forward -n tipsbank-web svc/web 8080:8080
```

## Regras de ouro

- O frontend não muda. Se ele funcionar, o contrato está certo.
- Containers não-root, sem shell, com tag versionada e 0 vulnerabilidades HIGH/CRITICAL.
- Configuração só por variáveis de ambiente.
- Collections Bruno 100% verdes.

---

Aplicação original © LinuxTips (Descomplicando Kubernetes 2025), adaptada para fins formativos.
