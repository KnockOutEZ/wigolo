# routing fetches through a Helodata proxy

> **Sponsored example.** [Helodata](https://wigolo.app/go/helodata/?ref=docs) sponsors wigolo. Any HTTP(S) proxy works the same way — see [Swapping providers](#swapping-providers).

From a home connection, wigolo rarely needs a proxy. From a VPS it can: anti-bot systems score IP reputation, and datacenter ranges start low, so some challenge-protected sites never clear from a server no matter what the client does. For legitimate research that keeps hitting that wall, route fetches through a proxy whose IP reputation matches your use.

## Set it up

1. Create a sub-user at [Helodata](https://wigolo.app/go/helodata/?ref=docs) and note its username and password. Helodata puts targeting in the username: `-type-res` asks for residential IPs, `-region-us` for US exits.
2. Turn proxying on and give wigolo the proxy URL:

```bash
wigolo config --set useProxy=true
export PROXY_URL=http://helo_<sub-user>-type-res-region-us:<password>@gate.helodata.io:7777
wigolo serve
```

The credentials in `PROXY_URL` never touch disk: wigolo moves the username and password into the OS keychain and stores only the credential-free URL.

## Check it

```bash
npx wigolo fetch https://ipv4.icanhazip.com
```

The page body is the proxy's exit IP, not your server's.

## What stays the same

Politeness applies through a proxy exactly as without one: robots.txt is respected by default, requests are rate-limited per domain, and volumes stay research-grade. When a page still can't be cleared, you get a labeled `blocked_by_challenge` failure, never junk presented as content.

## Swapping providers

Any HTTP(S) proxy works: set `PROXY_URL` to its `http://user:pass@host:port` URL. See [self-hosting](../../docs/self-hosting.md#the-datacenter-ip-reality) and [configuration](../../docs/configuration.md#fetch-and-browser-engine).
