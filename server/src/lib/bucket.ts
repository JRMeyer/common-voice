import { S3 } from 'aws-sdk';
import { getConfig } from '../config-helper';
import Model from './model';
import { Clip, TakeoutRequest } from 'common';

const s3Zip = require('s3-zip');

/**
 * Bucket
 *   The bucket class is responsible for loading clip
 *   metadata into the Model from s3.
 */
export default class Bucket {
  private model: Model;
  private s3: S3;

  constructor(model: Model, s3: S3) {
    this.model = model;
    this.s3 = s3;
  }

  /**
   * Fetch a public url for the resource.
   */
  public getPublicUrl(key: string, bucketType?: string, cdn?: boolean) {
    // @TODO: add CDN handling back in
    return this.s3.getSignedUrl('getObject', {
      Bucket:
        bucketType === 'dataset'
          ? getConfig().DATASET_BUCKET_NAME
          : getConfig().CLIP_BUCKET_NAME,
      Key: key,
      Expires: 60 * 60 * 12,
    });
  }

  /**
   * Construct the public URL for a resource that needs no token
   */
  public getUnsignedUrl(bucket: string, key: string) {
    return getConfig().ENVIRONMENT === 'local'
      ? `${getConfig().S3_CONFIG.endpoint}/${
          getConfig().CLIP_BUCKET_NAME
        }/${key}`
      : `https://${bucket}.s3.dualstack.${
          getConfig().BUCKET_LOCATION
        }.amazonaws.com/${key}`;
  }

  /**
   * Delete function for S3 used for removing old avatars
   */
  public async deleteAvatar(client_id: string, url: string) {
    let urlParts = url.split('/');
    if (urlParts.length) {
      const fileName = urlParts[urlParts.length - 1];

      await this.s3
        .deleteObject({
          Bucket: getConfig().CLIP_BUCKET_NAME,
          Key: `${client_id}/${fileName}`,
        })
        .promise();
    }
  }

  /**
   * Grab metadata to play clip on the front end.
   */
  async getRandomClips(
    client_id: string,
    locale: string,
    count: number
  ): Promise<Clip[]> {
    // Get more clip IDs than are required in case some are broken links or clips
    const clips = await this.model.findEligibleClips(
      client_id,
      locale,
      Math.ceil(count * 1.5)
    );
    const clipPromises: Clip[] = [];

    // Use for instead of .map so that it can break once enough clips are assembled
    for (let i = 0; i < clips.length; i++) {
      const { id, path, sentence, original_sentence_id, taxonomy } = clips[i];

      try {
        const metadata = await this.s3
          .headObject({
            Bucket: getConfig().CLIP_BUCKET_NAME,
            Key: path,
          })
          .promise();

        // if the clip is smaller than 256 bytes it is most likely blank and should be skipped
        if (metadata.ContentLength >= 256) {
          clipPromises.push({
            id: id.toString(),
            glob: path.replace('.mp3', ''),
            sentence: { id: original_sentence_id, text: sentence, taxonomy },
            audioSrc: this.getPublicUrl(path),
          });
        } else {
          console.log(`clip_id ${id} at ${path} is smaller than 256 bytes`);
          await this.model.db.markInvalid(id.toString());
        }

        // this will break either when 10 clips have been retrieved or when 15 have been tried
        // as long as at least 1 clip is returned, the next time the cache refills it will try
        // for another 15
        if (clipPromises.length == count) break;
      } catch (e) {
        console.log(e.message);
        console.log(`aws error retrieving clip_id ${id}`);
      }
    }

    return Promise.all(clipPromises);
  }

  async getClientClips(client_id: string): Promise<S3.Object[]> {
    const s3 = this.s3;

    async function allKeys(
      params: S3.Types.ListObjectsV2Request
    ): Promise<S3.Object[]> {
      params = { ...params };
      const items = [];
      do {
        const data = await s3.listObjectsV2(params).promise();
        params.ContinuationToken = data.NextContinuationToken;
        items.push(...data.Contents);
      } while (params.ContinuationToken);
      return items;
    }

    const bucket = getConfig().CLIP_BUCKET_NAME;
    const prefix = `${client_id}/`;
    return (await allKeys({ Bucket: bucket, Prefix: prefix })).filter(
      item => item.Key.startsWith(prefix) && item.Key.endsWith('.mp3')
    );
  }

  takeoutKey(takeout: TakeoutRequest, chunk_offset: number): string {
    return `${takeout.client_id}/takeout/${takeout.id}/${chunk_offset}.zip`;
  }

  async zipTakeoutFilesToS3(
    takeout: TakeoutRequest,
    chunk_offset: number,
    keys: string[]
  ): Promise<S3.ManagedUpload.SendData> {
    console.log('start takeout zipping', takeout.id);
    const folder = `${takeout.client_id}/`;
    const destination = this.takeoutKey(takeout, chunk_offset);
    const bucket = getConfig().CLIP_BUCKET_NAME;
    const keysWithoutFolder = keys.map(x => x.substr(folder.length));
    const body = s3Zip.archive(
      { s3: this.s3, bucket },
      folder,
      keysWithoutFolder
    );
    return await this.s3
      .upload({
        Bucket: bucket,
        Body: body,
        Key: destination,
        // TODO: enable this, currently bugs out s3proxy
        // Tagging: 'Type=takeout'
      })
      .promise();
  }

  getAvatarClipsUrl(path: string) {
    return this.getPublicUrl(path);
  }

  async getClipUrl(id: string): Promise<string> {
    const clip = await this.model.db.findClip(id);
    return clip ? this.getPublicUrl(clip.path) : null;
  }
}
