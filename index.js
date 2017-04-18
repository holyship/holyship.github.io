const Nightmare = require('nightmare');
const nightmare = Nightmare({
  show: true,
  // switches: {
  //   'proxy-server': '223.247.231.120:8998',
  //   'ignore-certificate-errors': true
  // }
});
const fs = require('fs');
const yaml = require('js-yaml');
const sanitize = require("sanitize-filename");
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const glob = require("glob");

const SEARCH_HOME = 'http://wx.sogou.com';
const SEARCH_BOX_INPUT = 'input[name=query]';
const SEARCH_BUTTON = 'input[type="button"][value="搜公众号"]';
const SEARCH_RESULT_URL = '.news-box a[target="_blank"]';
const ARTICLE_TITLE = '.weui_media_box h4';
const ARTICLE_INFO = '.weui_media_box .weui_media_extra_info';
const RECENT_SIGNAL = '.news-box dl:last-child dt';
const RECENT_ARTICLE = '.news-box dl:last-child dd a';
const RECENT_ARTICLE_TIME = '.news-box dl:last-child dd span';

function writeFile(path, data) {
  return new Promise((resolve, reject) =>
    fs.writeFile(path, data, (err) => {
      if (err) reject(err);
      else resolve();
    })
  );
}

function download(url, dest) {
  console.log(`download ${url} to ${dest}`);
  const file = fs.createWriteStream(dest);
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http).get(url, function(response) {
      response.pipe(file);
      file.on('finish', function() {
        file.close(err => {
          if (err) reject(err);
          else resolve();
        });
      });
    }).on('error', function(err) {
      fs.unlink(dest);
      reject(err);
    });
  });
};

function sha1File(file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file, function(err, data) {
      if (err) reject(err);
      else resolve(sha1(data));
    })
  });
}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function escapeRegExp(str) {
  return str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}
function replaceAll(str, find, replace) {
  return str.replace(new RegExp(escapeRegExp(find), 'g'), replace);
}

function downloadImages(id, images, data) {
  return images
    .reduce((promise, url) => {
      let suffix = '';
      const match = url.match(/wx_fmt=(.+?)$/);
      if (match) {
        suffix = `.${match[1]}`;
      }
      const tempFile = `./_${id}/images/${sha1(url)}`;
      return promise
        .then(() => download(url, tempFile))
        .then(() => sha1File(tempFile))
        .then(hash => {
          const newUrl = `${id}/images/${hash}${suffix}`;
          data = replaceAll(data, url, `/${newUrl}`);
          const targetFileName = `./_${newUrl}`;
          if (fs.existsSync(targetFileName)) {
            console.log(`duplicate file found, delete ${tempFile}`);
            fs.unlink(tempFile);
          } else {
            console.log(`rename ${tempFile} to ${targetFileName}`);
            fs.renameSync(tempFile, targetFileName);
          }
        })
    }, Promise.resolve())
    .then(() => data);
}

function saveArticle(id, { title, author, date, content, fullPath, images }) {
  return downloadImages(id, images, `---
${yaml.safeDump({
  title,
  author,
  date: `${new Date(date).toISOString().slice(0, 19).replace('T', ' ')} +0000`
})}
---

{% raw  %}
${content}
{% endraw  %}

`).then((data) => writeFile(fullPath, data));
}

function sleep(time) {
  return new Promise(resolve => {
    setTimeout(resolve, time);
  })
}

function waitUntilNoVerify() {
  return nightmare
    .wait('body')
    .exists('.page_verify')
    .then(verify => {
      if (verify) {
        console.log('waiting for verify');
        console.log('\007'); // beep
        return sleep(1000 * 10)
          .then(() => waitUntilNoVerify());
      }
    });
}

function pad0(x) {
  if (x < 10) return `0${x}`;
  return `${x}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${pad0(d.getMonth() + 1)}-${pad0(d.getDate())}`;
}

function getDateOnly(info) {
  return formatDate(info.split(/年|月|日|原创/).filter(v => v).join('-'));
}

function fileExist(patten) {
  return new Promise((resolve, reject) => {
    glob(patten, {}, function (error, files) {
      if (error) {
        reject(error);
        return;
      }
      console.log(`${patten} : `, files);
      resolve(files.length > 0);
    });
  });
}

function processArticles(id, processingIndex, cacheImage) {
  if (processingIndex < 0) return Promise.resolve();
  console.log(`start on #${processingIndex}`);
  const article = {};
  return waitUntilNoVerify().then(() =>
    nightmare
      .evaluate(function(titleSelector, infoSelector, idx) {
        return {
          title: document.querySelectorAll(titleSelector)[idx].innerText.replace(/\n|\r|\t/g, '').trim(),
          info: document.querySelectorAll(infoSelector)[idx].innerText.replace(/\n|\r|\t/g, '').trim(),
        };
      }, ARTICLE_TITLE, ARTICLE_INFO, processingIndex)
    )
    .then((basicInfo) => {
      Object.assign(article, basicInfo);
      const fileName = sanitize(`${getDateOnly(article.info)}-${article.title}.html`);
      const fileFullPath = `./_${id}/${fileName}`;
      article.fullPath = fileFullPath;
      if (fs.existsSync(fileFullPath)) {
        // skip if exist
        console.log(`skiping: ${fileFullPath}`);
        return processArticles(id, processingIndex - 1, cacheImage);
      }
      // process the detail content
      console.log(`processing: ${fileFullPath}`);
      return nightmare
        .evaluate(function(titleSelector, idx) {
          document.querySelectorAll(titleSelector)[idx].click();
        }, ARTICLE_TITLE, processingIndex)
        .then(() => waitUntilNoVerify())
        .then(() =>
          nightmare.wait('.rich_media_content')
          .evaluate(function() {
            // remove all lazy loading image
            const images = [];
            document.querySelectorAll('img[data-src]').forEach(e => {
              const newImg = document.createElement('img');
              images.push(e.dataset.src);
              newImg.src = e.dataset.src;
              newImg.style = e.style.cssText;
              e.parentElement.insertBefore(newImg, e);
              e.remove();
            });
            return {
              date: new Date(document.querySelector('#post-date').innerText),
              author: document.querySelector('#post-date ~ em,#post-user').innerText,
              content: document.querySelector('.rich_media_content').innerHTML.trim(),
              images,
            };
          })
        )
        .then((data) => {
          Object.assign(article, data);
          if (!cacheImage) article.images = [];
          return saveArticle(id, article);
        })
        .then(() => nightmare.back())
        .then(() => processArticles(id, processingIndex - 1, cacheImage));
    });
}

function createFeed(id, title, description) {
  const data = `---
layout: null
---
<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">

  <title>${title}</title>
  <description>${description}</description>
  <link href="/${id}.xml"/>
  <link type="application/atom+xml" rel="self" href="/${id}.xml"/>
  <updated>{{ site.time | date_to_xmlschema }}</updated>
  <id>${id}</id>

  {% for post in site.${id} %}
  <entry>
    <id>{{ post.id }}</id>
    <link type="text/html" rel="alternate" href="{{ post.url }}"/>
    <title>{{ post.title | xml_escape }}</title>
    <updated>{{ post.date | date_to_xmlschema }}</updated>
    <author>
      <name>{{ post.author }}</name>
    </author>
    <content type="html">{{ post.content | xml_escape }}</content>
  </entry>
  {% endfor %}

</feed>
`;
  return writeFile(`./${id}.xml`, data);
}

function timeMatch(str) {
  if (!str) return undefined;
  const hourMath = str.match(/^(\d+)小时前$/);
  if (hourMath) {
    return formatDate(Date.now() - (+hourMath[1]) * 3600 * 1000);
  }
  const dayMath = str.match(/^(\d+)天前$/);
  if (dayMath) {
    return formatDate(Date.now() - (+dayMath[1] + 1) * 3600 * 1000 * 24);
  }
  const dateMath = str.match(/^\d{4}-\d+-\d+$/);
  if (dateMath) {
    return formatDate(str);
  }

  return undefined;
}

function crawl(feeds) {
  return feeds
    .reduce((promise, {id, cache_image}, currentIndex) =>
      promise.then(() => {
        console.log(`=================== ${currentIndex} - ${id} ===================`)
        let articleCount;
        let listUrl;

        const folder = `./_${id}`;
        if (!fs.existsSync(folder)) {
          fs.mkdirSync(folder);
          fs.mkdirSync(`${folder}/images`);
        }
        return nightmare
          .goto(SEARCH_HOME)
          .type(SEARCH_BOX_INPUT, id)
          .click(SEARCH_BUTTON)
          .wait(SEARCH_RESULT_URL)
          .evaluate(function(resultUrl, recentArticle, recentArticleTime, recentSignal) {
            const recentSignalText = document.querySelector(recentSignal).innerText.trim();
            if (recentSignalText !== '最近文章：') {
              return { noUpdate: true };
            }
            const article = document.querySelector(recentArticle);
            const time = document.querySelector(recentArticleTime);
            let result = {};
            if (article && time) {
              result = {
                recentArticle: article.innerText.trim(),
                time: time.innerText.trim(),
              }
            }
            result.url = document.querySelector(resultUrl).href
            return result;
          }, SEARCH_RESULT_URL, RECENT_ARTICLE, RECENT_ARTICLE_TIME, RECENT_SIGNAL)
          .then(({url, recentArticle, time, noUpdate}) => {// go to result url
            listUrl = url;
            if (noUpdate) {
              console.log('no recent update');
              return true;
            }
            const timeStr = timeMatch(time);
            if (timeStr) {
              const fileFullPath = `./_${id}/${
                sanitize(`${timeStr}-${
                  recentArticle.replace(/[\|\?\(\)\.,:!~]+/g, '__MATCHANY__')
                }.html`).replace(/__MATCHANY__/g, '*')
              }`;
              return fileExist(fileFullPath);
            }
            return false;
          })
          .then((ship) => {
            if (ship) {
              return undefined;
            }
            return nightmare
              .goto(listUrl)
              .then(() => waitUntilNoVerify())
              .then(() =>
                nightmare
                  .wait(ARTICLE_TITLE)
                  .evaluate(function(selector) {
                    return {
                      title: document.querySelector('.profile_nickname').innerText.trim(),
                      description: document.querySelector('.profile_desc_value').innerText.trim(),
                      count: document.querySelectorAll(selector).length,
                    };
                  }, ARTICLE_TITLE)
                  .then(({count, title, description}) => {
                    articleCount = count;
                    return createFeed(id, title, description); // create feed
                  })
              )
              .then(() => // process articles
                processArticles(id, articleCount - 1, cache_image)
              )
          })
        })
    , Promise.resolve())
    .catch(console.error)
    .then(() => nightmare.end());
}

function getCollection(args) {
  try {
    const doc = yaml.safeLoad(fs.readFileSync('./_config.yml', 'utf8'));
    let feeds = Object.keys(doc.collections).map(id => Object.assign({ id }, doc.collections[id]));
    if (args.length === 1) {
      const startPos = parseInt(args[0]);
	  if (isNaN(startPos)) {
		feeds = feeds.filter(f => f.id === args[0]);
	  } else {
        feeds = feeds.slice(startPos);
	  }
    } else if (args.length === 2) {
      feeds = feeds.slice(+args[0], +args[1]);
    }
    return feeds;
  } catch (e) {
    console.error(e);
  }
  return [];
}

// entry point

const args = process.argv.slice(2);

crawl(getCollection(args));
