#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const argv = require('minimist')(process.argv.slice(2))
const map = require('map-async')
const after = require('after')
const hyperquest = require('hyperquest')
const bl = require('bl')
const semver = require('semver')

const transformFilename = require('./transform-filename')
const decodeRef = require('./decode-ref')
const isSecurityRelease = require('./is-security-release')

const versionCachePath = path.join(process.env.HOME, '.dist-indexer-version-cache')

// needs auth: githubContentUrl = 'https://api.github.com/repos/nodejs/node/contents'
const githubContentUrl = 'https://raw.githubusercontent.com/nodejs/{repo}/{gitref}'
const npmPkgJsonUrl = `${githubContentUrl}/deps/npm/package.json`
const v8VersionUrl = [
  `${githubContentUrl}/deps/v8/src/version.cc`,
  `${githubContentUrl}/deps/v8/include/v8-version.h`
]
const uvVersionUrl = [
  `${githubContentUrl}/deps/uv/include/uv-version.h`,
  `${githubContentUrl}/deps/uv/src/version.c`,
  `${githubContentUrl}/deps/uv/include/uv.h`,
  `${githubContentUrl}/deps/uv/include/uv/version.h`
]
const sslVersionUrl = [
  `${githubContentUrl}/deps/openssl/openssl/include/openssl/opensslv.h`,
  `${githubContentUrl}/deps/openssl/config/archs/linux-x86_64/asm/include/openssl/opensslv.h`,
  `${githubContentUrl}/deps/openssl/openssl/Makefile`
]
const zlibVersionUrl = `${githubContentUrl}/deps/zlib/zlib.h`
const modVersionUrl = [
  `${githubContentUrl}/src/node_version.h`,
  `${githubContentUrl}/src/node.h`
]
const ltsVersionUrl = `${githubContentUrl}/src/node_version.h`
const isSecurityUrl = 'https://github.com/nodejs/{repo}/commits/{gitref}.atom'
const githubOptions = {
  headers: {
    accept: 'text/plain,application/vnd.github.v3.raw'
  }
}

if (typeof argv.dist !== 'string') {
  throw new Error('Missing --dist <directory> argument')
}

if (typeof argv.indexjson !== 'string') {
  throw new Error('Missing --indexjson <directory> argument')
}

if (typeof argv.indextab !== 'string') {
  throw new Error('Missing --indextab <directory> argument')
}

if (!fs.statSync(argv.dist).isDirectory()) { throw new Error('"%s" is not a directory') }

let versionCache = {}

try {
  versionCache = JSON.parse(fs.readFileSync(versionCachePath, 'utf8'))
} catch (e) {}

function saveVersionCache () {
  fs.writeFileSync(versionCachePath, JSON.stringify(versionCache), 'utf8')
}

function cacheGet (gitref, prop) {
  return versionCache[gitref] && versionCache[gitref][prop]
}

function cachePut (gitref, prop, value) {
  if (prop && (value || value === false)) {
    (versionCache[gitref] || (versionCache[gitref] = {}))[prop] = value
  }
}

function fetch (url, gitref, callback) {
  const refparts = gitref.split('/')
  const repo = refparts[0] === 'v8-canary'
    ? 'node-v8'
    : (/^v0\.\d\./).test(refparts[1])
      ? 'node-v0.x-archive'
      : 'node'

  url = url.replace('{gitref}', refparts[1])
    .replace('{repo}', repo) +
           `?rev=${refparts[1]}`
  hyperquest.get(url, githubOptions).pipe(bl((err, data) => {
    if (err) {
      return callback(err)
    }

    callback(null, data.toString())
  }))
}

function fetchNpmVersion (gitref, callback) {
  const version = cacheGet(gitref, 'npm')
  if (version || (/\/v0\.([012345]\.\d+|6\.[0-2])$/).test(gitref)) {
    return setImmediate(callback.bind(null, null, version))
  }

  fetch(npmPkgJsonUrl, gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    let data

    try {
      data = JSON.parse(rawData)
    } catch (e) {
      return callback(e)
    }

    cachePut(gitref, 'npm', data.version)
    return callback(null, data.version)
  })
}

function fetchV8Version (gitref, callback) {
  let version = cacheGet(gitref, 'v8')
  if (version) {
    return setImmediate(callback.bind(null, null, version))
  }

  fetch(v8VersionUrl[0], gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    version = rawData.split('\n').map((line) => {
      return line.match(/^#define (?:MAJOR_VERSION|MINOR_VERSION|BUILD_NUMBER|PATCH_LEVEL)\s+(\d+)$/)
    })
      .filter(Boolean)
      .map((m) => m[1])
      .join('.')

    if (version) {
      cachePut(gitref, 'v8', version)
      return callback(null, version)
    }

    fetch(v8VersionUrl[1], gitref, (err, rawData) => {
      if (err) {
        return callback(err)
      }

      version = rawData.split('\n').map((line) => {
        return line.match(/^#define V8_(?:MAJOR_VERSION|MINOR_VERSION|BUILD_NUMBER|PATCH_LEVEL)\s+(\d+)$/)
      })
        .filter(Boolean)
        .map((m) => m[1])
        .join('.')

      cachePut(gitref, 'v8', version)
      callback(null, version)
    })
  })
}

function fetchUvVersion (gitref, callback) {
  let version = cacheGet(gitref, 'uv')
  if (version || (/\/v0\.([01234]\.\d+|5\.0)$/).test(gitref)) {
    return setImmediate(callback.bind(null, null, version))
  }

  fetch(uvVersionUrl[0], gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    version = rawData.split('\n').map((line) => {
      return line.match(/^#define UV_VERSION_(?:MAJOR|MINOR|PATCH)\s+(\d+)$/)
    })
      .filter(Boolean)
      .map((m) => m[1])
      .join('.')

    if (version) {
      cachePut(gitref, 'uv', version)
      return callback(null, version)
    }

    fetch(uvVersionUrl[1], gitref, (err, rawData) => {
      if (err) {
        return callback(err)
      }

      version = rawData.split('\n').map((line) => {
        return line.match(/^#define UV_VERSION_(?:MAJOR|MINOR|PATCH)\s+(\d+)$/)
      })
        .filter(Boolean)
        .map((m) => m[1])
        .join('.')

      if (version) {
        cachePut(gitref, 'uv', version)
        return callback(null, version)
      }

      fetch(uvVersionUrl[2], gitref, (err, rawData) => {
        if (err) {
          return callback(err)
        }

        version = rawData.split('\n').map((line) => {
          return line.match(/^#define UV_VERSION_(?:MAJOR|MINOR|PATCH)\s+(\d+)$/)
        })
          .filter(Boolean)
          .map((m) => m[1])
          .join('.')

        if (version) {
          cachePut(gitref, 'uv', version)
          return callback(null, version)
        }

        fetch(uvVersionUrl[3], gitref, (err, rawData) => {
          if (err) {
            return callback(err)
          }

          version = rawData.split('\n').map((line) => {
            return line.match(/^#define UV_VERSION_(?:MAJOR|MINOR|PATCH)\s+(\d+)$/)
          })
            .filter(Boolean)
            .map((m) => m[1])
            .join('.')

          cachePut(gitref, 'uv', version)
          callback(null, version)
        })
      })
    })
  })
}

function fetchSslVersion (gitref, callback) {
  let version = cacheGet(gitref, 'ssl')
  if (version || (/\/v0\.([01234]\.\d+|5\.[0-4])$/).test(gitref)) {
    return setImmediate(callback.bind(null, null, version))
  }

  fetch(sslVersionUrl[0], gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    const m = rawData.match(/^#\s*define OPENSSL_VERSION_TEXT\s+"OpenSSL ([^\s]+)/m)
    version = m && m[1]

    if (version) {
      version = version.replace(/-fips$/, '')
      cachePut(gitref, 'ssl', version)

      return callback(null, version)
    }

    fetch(sslVersionUrl[1], gitref, (err, rawData) => {
      if (err) {
        return callback(err)
      }

      const m = rawData.match(/^#\s*define OPENSSL_VERSION_TEXT\s+"OpenSSL ([^\s]+)/m)
      version = m && m[1]

      if (version) {
        version = version.replace(/-fips$/, '')
        cachePut(gitref, 'ssl', version)

        return callback(null, version)
      }

      fetch(sslVersionUrl[2], gitref, (err, rawData) => {
        if (err) {
          return callback(err)
        }

        const m = rawData.match(/^VERSION=(.+)$/m)
        version = m && m[1]
        cachePut(gitref, 'ssl', version)

        callback(null, version)
      })
    })
  })
}

function fetchZlibVersion (gitref, callback) {
  let version = cacheGet(gitref, 'zlib')
  if (version || (/\/v0\.([01234]\.\d+|5\.[0-7])$/).test(gitref)) {
    return setImmediate(callback.bind(null, null, version))
  }

  fetch(zlibVersionUrl, gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    const m = rawData.match(/^#define ZLIB_VERSION\s+"(.+)"$/m)
    version = m && m[1]
    cachePut(gitref, 'zlib', version)

    callback(null, version)
  })
}

function fetchModVersion (gitref, callback) {
  let version = cacheGet(gitref, 'mod')
  if (version || (/\/v0\.1\.\d+$/).test(gitref)) {
    return setImmediate(callback.bind(null, null, version))
  }

  fetch(modVersionUrl[0], gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    let m = rawData.match(/^#define NODE_MODULE_VERSION\s+((?!NODE_EMBEDDER_MODULE_VERSION)[^\s]+)\s+.+$/m)
    version = m && m[1]

    if (version) {
      cachePut(gitref, 'mod', version)
      return callback(null, version)
    }

    fetch(modVersionUrl[1], gitref, (err, rawData) => {
      if (err) {
        return callback(err)
      }

      m = rawData.match(/^#define NODE_MODULE_VERSION\s+\(?([^\s)]+)\)?\s+.+$/m)
      version = m && m[1]
      cachePut(gitref, 'mod', version)
      callback(null, version)
    })
  })
}

function fetchLtsVersion (gitref, callback) {
  let version = cacheGet(gitref, 'lts')

  if (version || version === false) {
    return setImmediate(callback.bind(null, null, version))
  }

  fetch(ltsVersionUrl, gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    let m = rawData.match(/^#define NODE_VERSION_IS_LTS 1$/m)
    if (m) {
      m = rawData.match(/^#define NODE_VERSION_LTS_CODENAME "([^"]+)"$/m)
      version = m && m[1]
    } else {
      version = false
    }

    cachePut(gitref, 'lts', version)
    callback(null, version)
  })
}

function fetchSecurity (gitref, callback) {
  let security = cacheGet(gitref, 'security')

  if (security || security === false) {
    return setImmediate(callback.bind(null, null, security))
  }

  fetch(isSecurityUrl, gitref, (err, rawData) => {
    if (err) {
      return callback(err)
    }

    security = isSecurityRelease(rawData)
    cachePut(gitref, 'security', security)
    callback(null, security)
  })
}

function dirDate (dir, callback) {
  fs.readdir(path.join(argv.dist, dir), (err, files) => {
    if (err) {
      return callback(err)
    }

    const mtime = (file, callback) => {
      const ignoreDirectoryDate = new Date('2019-10-01')
      fs.stat(path.join(argv.dist, dir, file), (err, stat) => {
        if (err || !stat) {
          return callback(err)
        }
        if (!stat.isFile() && stat.mtime >= ignoreDirectoryDate) {
          // is a directory, but we stopped using directories as a date reference in Oct-19
          // and don't want to rewrite old dates
          return callback(null)
        }
        callback(null, stat.mtime) // is a file
      })
    }

    const afterMap = (err, mtimes) => {
      if (err) {
        return callback(err)
      }
      mtimes = mtimes.filter(Boolean)
      mtimes.sort((d1, d2) => d1 < d2 ? -1 : d1 > d2 ? 1 : 0)
      callback(null, mtimes[0])
    }

    map(files, mtime, afterMap)
  })
}

function dirFiles (dir, callback) {
  // TODO: look in SHASUMS.txt as well for older versions
  fs.readFile(path.join(argv.dist, dir, 'SHASUMS256.txt'), 'utf8', (err, contents) => {
    if (err) {
      return callback(err)
    }

    const files = contents.split('\n').map((line) => {
      const seg = line.split(/\s+/)
      return seg.length >= 2 && seg[1]
    })
      .map(transformFilename)
      .filter(Boolean)
      .sort()

    callback(null, files)
  })
}

function inspectDir (dir, callback) {
  const gitref = decodeRef(dir)
  let files
  let npmVersion
  let v8Version
  let uvVersion
  let sslVersion
  let zlibVersion
  let modVersion
  let ltsVersion
  let securityRelease
  let date

  if (!gitref) {
    return fs.stat(path.join(argv.dist, dir), (err, stat) => {
      if (err) {
        return callback(err)
      }
      if (stat.isDirectory() && !(/^(latest|npm$|patch$|v0\.10\.16-isaacs-manual$)/).test(dir)) {
        console.error(`Ignoring directory "${dir}" (can't decode ref)`)
      }
      return callback()
    })
  }

  const afterAll = (err) => {
    if (err) {
      console.error(err)
      console.error('(ignoring directory due to error %s)', dir)
      return callback()
    }

    callback(null, {
      version: dir,
      date: date.toISOString().substring(0, 10),
      files: files,
      npm: npmVersion,
      v8: v8Version,
      uv: uvVersion,
      zlib: zlibVersion,
      openssl: sslVersion,
      modules: modVersion,
      lts: ltsVersion,
      security: securityRelease
    })
  }

  dirFiles(dir, (err, _files) => {
    if (err) {
      console.error(`Ignoring directory "${dir}" (can't decode dir contents)`)
      return callback() // not a dir we care about
    }

    files = _files

    const done = after(9, afterAll)

    dirDate(dir, (err, _date) => {
      if (err) {
        return done(err)
      }

      date = _date
      done()
    })

    fetchNpmVersion(gitref, (err, version) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching npm version for %s)', gitref)
      }
      npmVersion = version
      done()
    })

    fetchV8Version(gitref, (err, version) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching V8 version for %s)', gitref)
      }
      v8Version = version
      done()
    })

    fetchUvVersion(gitref, (err, version) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching uv version for %s)', gitref)
      }
      uvVersion = version
      done()
    })

    fetchSslVersion(gitref, (err, version) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching OpenSSL version for %s)', gitref)
      }
      sslVersion = version
      done()
    })

    fetchZlibVersion(gitref, (err, version) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching zlib version for %s)', gitref)
      }
      zlibVersion = version
      done()
    })

    fetchModVersion(gitref, (err, version) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching modules version for %s)', gitref)
      }
      modVersion = version
      done()
    })

    fetchLtsVersion(gitref, (err, version) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching LTS version for %s)', gitref)
      }
      ltsVersion = version
      done()
    })

    fetchSecurity(gitref, (err, security) => {
      if (err) {
        console.error(err)
        console.error('(ignoring error fetching security release for %s)', gitref)
      }
      securityRelease = security
      done()
    })
  })
}

map(fs.readdirSync(argv.dist).sort().reverse(), inspectDir, (err, dirs) => {
  if (err) {
    throw err
  }

  dirs.sort((d1, d2) => semver.compare(d2.version, d1.version))

  saveVersionCache()

  dirs = dirs.filter(Boolean)

  const jsonOut = fs.createWriteStream(argv.indexjson, 'utf8')
  const tabOut = fs.createWriteStream(argv.indextab, 'utf8')

  function tabWrite () {
    const args = [].slice.call(arguments).map((a) => a || '-')
    tabOut.write(args.join('\t') + '\n')
  }

  jsonOut.write('[\n')
  tabWrite('version', 'date', 'files', 'npm', 'v8', 'uv', 'zlib', 'openssl', 'modules', 'lts', 'security')

  dirs.forEach((dir, i) => {
    jsonOut.write(JSON.stringify(dir) + (i !== dirs.length - 1 ? ',\n' : '\n'))
    tabWrite(
      dir.version,
      dir.date,
      dir.files.join(','),
      dir.npm,
      dir.v8,
      dir.uv,
      dir.zlib,
      dir.openssl,
      dir.modules,
      dir.lts,
      dir.security
    )
  })

  jsonOut.write(']\n')

  jsonOut.end()
  tabOut.end()
})
