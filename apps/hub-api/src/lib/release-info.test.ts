import assert from "node:assert/strict";
import test from "node:test";
import { compareRelease, publishedVersions } from "./release-info.js";
test("release channels ignore drafts, prereleases and unrelated release assets",()=>{
 const data=publishedVersions([{tag_name:"cli-v0.4.0"},{tag_name:"desktop-v0.3.8"},{tag_name:"desktop-v0.4.0",assets:[{name:"latest.json",browser_download_url:"https://github.com/ensemblework/ensemble/releases/download/desktop-v0.4.0/latest.json"},{name:"unsafe",browser_download_url:"https://example.test/file"}]},{tag_name:"desktop-v9.0.0",draft:true},{tag_name:"cli-v9.0.0",prerelease:true}]);
 assert.equal(data.cli?.version,"0.4.0");assert.equal(data.desktop?.version,"0.4.0");assert.equal(data.desktop?.assets.length,1);assert.ok(compareRelease("0.4.0","0.3.11")>0);assert.ok(compareRelease("0.10.0","0.9.0")>0);
});
