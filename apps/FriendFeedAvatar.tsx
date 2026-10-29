import React, {useState} from 'react';
import {isImageValue, useBlobRefUrl} from '../utils/blobRef';

export default function FriendFeedAvatar({name, avatar}: {name: string; avatar?: string}) {
    const image = useBlobRefUrl(isImageValue(avatar) ? avatar : undefined);
    const [failed, setFailed] = useState<string>();
    return <span className="friend-feed-avatar" aria-hidden="true">
        {image && failed !== image ? <img src={image} alt="" onError={() => setFailed(image)}/>
            : avatar && !isImageValue(avatar) ? avatar : Array.from(name || '友')[0]}
    </span>;
}
