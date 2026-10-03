# Engineering Learning Hub

Static catalog + viewer around existing HTML learning artifacts.
The hub never rewrites artifacts — each one is loaded unchanged in an iframe.

```
index.html         dashboard (search, filters, favorites, recent, continue learning, dark mode)
viewer.html        thin nav bar + iframe → viewer.html?topic=<id>
artifacts/         original artifact HTML files (immutable)
assets/            hub CSS/JS only
topics.json        dashboard metadata only
```

## Add a topic

1. Copy the HTML file into `artifacts/`, e.g. `artifacts/java-concurrency.html`.
2. Add an entry to `topics.json`:

   ```json
   {
     "id": "java-concurrency",
     "title": "Java Concurrency",
     "category": "Backend Engineering",
     "description": "Threads, executors, locks and the JMM",
     "path": "artifacts/java-concurrency.html",
     "highlights": ["Executors", "Locks", "Memory Model"],
     "tags": ["Java", "Concurrency"]
   }
   ```

   Only `id` and `title` are required. `path` defaults to `artifacts/<id>.html`.
   Array order = Previous/Next order in the viewer.
3. `git push`.

## Artifact storage isolation

Artifacts were built to run on their own origin; here they share one, so generic `localStorage`
keys (both current artifacts use `course-done`) would collide. The viewer keeps a per-topic copy
under `elh.ns.<id>`, swaps it in before the iframe loads, and mirrors the artifact's writes back
out via `storage` events. Artifact files stay untouched. Limitation: two *different* topics open in
two tabs at once can still mix their in-artifact progress.

## Run locally

`fetch()` doesn't work on `file://`, so serve the folder:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

- **GitHub Pages**: Settings → Pages → deploy from branch, root folder. `.nojekyll` is included.
  Works under a project sub-path (`user.github.io/repo/`) because paths are relative.
- **Netlify / Vercel**: import repo, no build command, publish directory = repo root.
