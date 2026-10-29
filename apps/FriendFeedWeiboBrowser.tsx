import React,{useEffect,useRef,useState} from 'react';
import {readWeiboProfile,readWeiboProfilePosts,readWeiboOriginalComments,readWeiboConnection,WEIBO_CONNECTION_CHANGED,type WeiboProfile} from '../utils/friendFeedWeibo';
import type {FriendFeedSource} from '../utils/friendFeedSource';
import type {WeiboOriginalComment} from '../utils/friendFeedSourceComments';
import FriendFeedAvatar from './FriendFeedAvatar';
import FriendFeedImages from './FriendFeedImages';

/** Real browsing stays in this page's memory; it does not alter RP bindings or the home timeline. */
export default function FriendFeedWeiboBrowser({uid,post,onPost,onProfile,onConnect}:{uid:string;post?:FriendFeedSource;onPost:(post:FriendFeedSource)=>void;onProfile:(uid:string)=>void;onConnect:()=>void}) {
    const [profile,setProfile]=useState<WeiboProfile>();
    const [posts,setPosts]=useState<FriendFeedSource[]>([]),[comments,setComments]=useState<WeiboOriginalComment[]>([]);
    const [page,setPage]=useState<number|null>(1),[cursor,setCursor]=useState<string|null>('0');
    const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
    const controller=useRef<AbortController>(),running=useRef(false);
    const load=async(more=false)=>{
        if(running.current)return;
        if(!readWeiboConnection()){setError('请先连接微博，再读取真实主页');return;}
        running.current=true;controller.current?.abort();const abort=new AbortController();controller.current=abort;
        setBusy(true);setError('');let profileError='';
        try{
            if(post){
                const result=await readWeiboOriginalComments(uid,post.externalId,more?cursor||'0':'0',abort.signal);
                if(abort.signal.aborted)return;
                setComments(current=>[...new Map([...(more?current:[]),...result.rows].map(c=>[c.id,c])).values()].slice(0,200));
                setCursor(result.cursor===cursor&&more?null:result.cursor);
            }else{
                if(!more){try{const info=await readWeiboProfile(uid,abort.signal);if(!abort.signal.aborted)setProfile(info);}catch(e){if(abort.signal.aborted)return;profileError=e instanceof Error?e.message:'主页资料读取失败';}}
                const result=await readWeiboProfilePosts(uid,more?page||1:1,abort.signal);
                if(abort.signal.aborted)return;
                const added=result.posts.some(p=>!posts.some(old=>old.externalId===p.externalId));
                setPosts(current=>[...new Map([...(more?current:[]),...result.posts].map(p=>[p.externalId,p])).values()].slice(0,200));
                setPage(more&&!added?null:result.nextPage);
            }
            setLoaded(true);setError(profileError);
        }catch(e){if(!abort.signal.aborted)setError([profileError,e instanceof Error?e.message:'微博读取失败'].filter(Boolean).join('；'));}
        finally{if(!abort.signal.aborted){running.current=false;setBusy(false);}}
    };
    useEffect(()=>{
        void load();
        const changed=()=>{controller.current?.abort();running.current=false;setBusy(false);setProfile(undefined);setPosts([]);setComments([]);setLoaded(false);setPage(1);setCursor('0');setError('微博连接已变化，请重新读取');};
        window.addEventListener(WEIBO_CONNECTION_CHANGED,changed);
        return()=>{controller.current?.abort();window.removeEventListener(WEIBO_CONNECTION_CHANGED,changed);};
    },[uid,post?.externalId]);
    const renderPost=(item:FriendFeedSource,detail=false)=><article className="ff-detail-original" key={item.externalId}>
        <header><button className="ff-setting-link" onClick={()=>onProfile(item.accountId!)}><FriendFeedAvatar name={item.author} avatar={item.authorAvatar||profile?.avatar}/><strong>{item.author}</strong></button>
            <time>{new Date(item.publishedAt!).toLocaleString('zh-CN')}</time></header>
        <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.text}</p>
        {!!item.images?.length&&<FriendFeedImages images={item.images}/>}
        {item.truncated&&<p className="ff-discussion-hint">正文摘录，完整内容可查看原帖。</p>}
        <div className="ff-setting-actions">{!detail&&<button className="ff-setting-link" onClick={()=>onPost(item)}>查看微博与原评论</button>}
            <a href={item.url} target="_blank" rel="noopener noreferrer">查看微博原帖 ↗</a></div>
    </article>;
    return <div className="ff-post-detail" aria-label={post?'真实微博详情':'真实微博主页'}>
        {!post&&<section className="ff-settings-intro"><FriendFeedAvatar name={profile?.name||'微博'} avatar={profile?.avatar}/><h2>{profile?.name||'微博主页'}</h2><p>UID {uid}</p>{profile?.description&&<p>{profile.description}</p>}
            <a href={`https://weibo.com/u/${uid}`} target="_blank" rel="noopener noreferrer">在微博打开主页 ↗</a></section>}
        {post?renderPost(post,true):posts.map(item=>renderPost(item))}
        {post&&<section className="ff-detail-discussion ff-original-comments" aria-label="微博原评论"><h2>微博原评论 <small>{comments.length}</small></h2>
            {comments.map(c=><article key={c.id} className="ff-detail-comment"><FriendFeedAvatar name={c.authorName}/><div><button className="ff-setting-link" onClick={()=>onProfile(c.authorId)}>{c.authorName}</button>
                {c.parentId&&<small> · 楼中楼回复</small>}<p>{c.text}</p><time>{new Date(c.createdAt).toLocaleString('zh-CN')}</time></div></article>)}
        </section>}
        {busy&&<p role="status">正在读取真实微博…</p>}
        {error&&<p role="alert">{error}</p>}
        {loaded&&!(post?comments:posts).length&&<p>微博本次返回 0 条{post?'可见评论':'动态'}。</p>}
        <div className="ff-setting-actions"><button className="ff-setting-button ff-setting-secondary" disabled={busy} onClick={()=>void load()}>{error?'重试读取':post?'刷新微博原评论':'刷新微博主页'}</button>
            {loaded&&(post?cursor&&comments.length<200:page&&posts.length<200)&&<button className="ff-setting-link" disabled={busy} onClick={()=>void load(true)}>{post?'查看更早的原评论':'加载更早微博'}</button>}
            {!readWeiboConnection()&&<button className="ff-setting-link" onClick={onConnect}>连接微博</button>}</div>
    </div>;
}
