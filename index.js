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

const DEFAULT_SLEEP_TIME = 2000;

const SEARCH_HOME = 'http://wx.sogou.com';
const SEARCH_BOX_INPUT = 'input[name=query]';
const SEARCH_BUTTON = 'input[type="button"][value="搜公众号"]';
const SEARCH_RESULT_URL = '.news-box a[target="_blank"]';
const ARTICLE_TITLE = '.weui_media_box h4';
const ARTICLE_INFO = '.weui_media_box .weui_media_extra_info';
const RECENT_SIGNAL = '.news-box dl:last-child dt';
const RECENT_ARTICLE = '.news-box dl:last-child dd a';
const RECENT_ARTICLE_TIME = '.news-box dl:last-child dd span';
const FEED_TITLE = '.tit';
const FEED_DESCRIPTION = '.news-box dl dd';

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
    .then(() => data)
    .catch(e => console.log(e));
}

function saveArticle(id, { title, author, date, content, fullPath, images, wechat_source }) {
  return downloadImages(id, images, `---
${yaml.safeDump({
  title,
  author,
  wechat_source,
  date: `${new Date(date).toISOString().slice(0, 19).replace('T', ' ')} +0000`
})}
---

{% raw  %}
${content}
{% endraw  %}

`).then((data) => writeFile(fullPath, data));
}

function sleep(time = DEFAULT_SLEEP_TIME) {
  return new Promise(resolve => {
    setTimeout(resolve, time);
  })
}

function waitUntilNoVerify() {
  return nightmare
    .wait('body')
    .exists('.page_verify,#seccodeForm')
    .then(verify => {
      if (verify) {
        console.log('waiting for verify\007');
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

function jumpIfOriginal() {
  return nightmare
    .wait('body')
    .exists('.original_panel_tool')
    .then(original => {
      if (original) {
	    return nightmare.evaluate(function() {
          return document.querySelector('.original_panel_tool a').href;
        })
		.then(url => nightmare.goto(url));
      }
    });
}

function processArticles(id, processingIndex, list, cacheImage) {
  if (processingIndex < 0) return Promise.resolve();
  console.log(`start on #${processingIndex}`);
  const article = Object.assign({}, list[processingIndex]);
  const fileName = sanitize(`${getDateOnly(article.info)}-${article.title}.html`);
  const fileFullPath = `./_${id}/${fileName}`;
  article.fullPath = fileFullPath;
  if (fs.existsSync(fileFullPath)) {
    // skip if exist
    console.log(`skiping: ${fileFullPath}`);
    return processArticles(id, processingIndex - 1, list, cacheImage);
  }
  // process the detail content
  console.log(`processing: ${fileFullPath}`);
  return nightmare
    .goto(article.url)
    .then(() => waitUntilNoVerify())
    .then(() => jumpIfOriginal())
    .then(() =>
      nightmare.wait('body')
      .evaluate(function() {
        const richMediaContent = document.querySelector('.rich_media_content');
        if (!richMediaContent) {
          return {};
        }

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
        let source = msg_source_url && ` | <a href="${msg_source_url}">阅读原文</a>`;
        return {
          date: new Date(document.querySelector('#post-date').innerText),
          author: document.querySelector('#post-date ~ em,#post-user').innerText,
          content: `${richMediaContent.innerHTML.trim()}<hr/><a href="${location.href}">微信地址</a>${source}`,
          wechat_source: location.href,
          images,
        };
      })
    )
    .then((data) => {
      if (!data.content) {
        console.log('skip for error.');
        return;
      }
      Object.assign(article, data);
      if (!cacheImage) article.images = [];
      return saveArticle(id, article);
    })
    .then(() => sleep())
    .then(() => processArticles(id, processingIndex - 1, list, cacheImage));
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
  {% assign posts = site.${id} | reverse | limit:10 %}
  {% for post in posts %}
  <entry>
    <id>{{ post.id }}</id>
    <link type="text/html" rel="alternate" href="{% if post.wechat_source == blank or post.wechat_source == nil %}{{ post.url }}{% else %}{{ post.wechat_source | xml_escape }}{% endif %}"/>
    <title>{{ post.title | xml_escape }}</title>
    <updated>{{ post.date | date_to_xmlschema }}</updated>
    <author>
      <name>{{ post.author | xml_escape }}</name>
    </author>
    <content type="html"><![CDATA[{{ post.content }} | <a href="{{ post.url }}">缓存地址</a>]]></content>
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
      promise
      .then(() => sleep())
      .then(() => {
        console.log(`=================== ${currentIndex} - ${id} ===================`)
        let listUrl;

        const folder = `./_${id}`;
        if (!fs.existsSync(folder)) {
          fs.mkdirSync(folder);
          fs.mkdirSync(`${folder}/images`);
        }
        return nightmare
          .goto(`http://wx.sogou.com/weixin?type=1&query=${id}&ie=utf8&s_from=input&_sug_=y&_sug_type_=`)
          .then(() => waitUntilNoVerify())
          .then(() =>
            nightmare.wait(SEARCH_RESULT_URL)
              .evaluate(function(resultUrl, recentArticle, recentArticleTime, recentSignal, titleSelector, desSelector) {
                const recentSignalText = document.querySelector(recentSignal).innerText.trim();
                if (recentSignalText !== '最近文章：') {
                  return { noUpdate: true };
                }
                const article = document.querySelector(recentArticle);
                const time = document.querySelector(recentArticleTime);
                let result = {};
                if (article && time) {
                  result = {
                    title: document.querySelector(titleSelector).innerText.trim().replace(/^\s*原创\s*(.+)/, "$1"),
                    description: document.querySelector(desSelector).innerText.trim(),
                    recentArticle: article.innerText.trim(),
                    time: time.innerText.trim(),
                  }
                }
                result.url = document.querySelector(resultUrl).href
                return result;
              }, SEARCH_RESULT_URL, RECENT_ARTICLE, RECENT_ARTICLE_TIME, RECENT_SIGNAL, FEED_TITLE, FEED_DESCRIPTION)
          ).then(({url, recentArticle, time, noUpdate, title, description}) => {// go to result url
            createFeed(id, title, description); // create feed
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
                  .evaluate(function(titleSelector, infoSelector) {
                    const list = [];
                    document.querySelectorAll(titleSelector).forEach(e => {
                      let url = e.getAttribute('hrefs');
                      if (!url.startsWith('http')) url = location.origin + url;
                      list.push({
                        url,
                        title: e.innerText.replace(/\n|\r|\t/g, '').trim(),
                      });
                    });
                    document.querySelectorAll(infoSelector).forEach((e, idx) => {
                      list[idx].info = e.innerText.replace(/\n|\r|\t/g, '').trim();
                    });
                    return list;
                  }, ARTICLE_TITLE, ARTICLE_INFO)
              )
              .then(list => // process articles
                processArticles(id, list.length - 1, list, cache_image)
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
