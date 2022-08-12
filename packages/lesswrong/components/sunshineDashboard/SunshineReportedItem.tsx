import { Components, registerComponent } from '../../lib/vulcan-lib';
import { useUpdate } from '../../lib/crud/withUpdate';
import React from 'react';
import { useHover } from '../common/withHover'
import withErrorBoundary from '../common/withErrorBoundary'
import { useCurrentUser } from '../common/withUser'
import DoneIcon from '@material-ui/icons/Done';
import DeleteIcon from '@material-ui/icons/Delete';
import { forumTypeSetting } from '../../lib/instanceSettings';
import PersonOutlineIcon from '@material-ui/icons/PersonOutline'
import { Link } from '../../lib/reactRouterWrapper'

const styles = (theme: ThemeType): JssStyles => ({
  reportedUserIcon: {
    height: 10,
    verticalAlign: "middle",
    width: 10,
    marginTop: -2,
    marginLeft: 4,
  },
});

const SunshineReportedItem = ({report, updateReport, classes}: {
  report: any,
  updateReport: WithUpdateFunction<ReportsCollection>,
  classes: ClassesType,
}) => {
  const currentUser = useCurrentUser();
  const { hover, anchorEl, eventHandlers } = useHover();
  const { mutate: updateComment } = useUpdate({
    collectionName: "Comments",
    fragmentName: 'CommentsListWithParentMetadata',
  });
  const { mutate: updatePost } = useUpdate({
    collectionName: "Posts",
    fragmentName: 'PostsList',
  });
  
  const handleReview = () => {
    void updateReport({
      selector: {_id: report._id},
      data: {
        closedAt: new Date(),
        claimedUserId: currentUser!._id,
        markedAsSpam: false
      }
    })
  }

  const handleDelete = () => {
    if (confirm(`Are you sure you want to immediately delete this ${report.comment ? "comment" : "post"}?`)) {
      if (report.comment) {
        void updateComment({
          selector: {_id: report.comment._id},
          data: {
            deleted: true,
            deletedDate: new Date(),
            deletedByUserId: currentUser!._id,
            deletedReason: "spam"
          }
        })
      } else if (report.post) {
        void updatePost({
          selector: {_id: report.post._id},
          data: { status: report.reportedAsSpam ? 4 : 5 }
        })
      }
      void updateReport({
        selector: {_id: report._id},
        data: {
          closedAt: new Date(),
          claimedUserId: currentUser!._id,
          markedAsSpam: report.reportedAsSpam
        }
      })
    }
  }

  const {comment, post, reportedUser} = report;
  const { SunshineListItem, SidebarInfo, SidebarHoverOver, PostsTitle, PostsHighlight, SidebarActionMenu, SidebarAction, FormatDate, CommentsNode, Typography, SunshineCommentsItemOverview, SunshineNewUsersInfo } = Components

  return (
    <span {...eventHandlers}>
      <SunshineListItem hover={hover}>
        <SidebarHoverOver hover={hover} anchorEl={anchorEl} >
          <Typography variant="body2">
            {comment && <CommentsNode
              treeOptions={{
                condensed: false,
                post: comment.post || undefined,
                tag: comment.tag || undefined,
                showPostTitle: true,
              }}
              comment={comment}
            />}
            {post && !comment && <div>
              <PostsTitle post={post}/>
              <PostsHighlight post={post} maxLengthWords={600}/>
            </div>}
            {reportedUser && <SunshineNewUsersInfo user={reportedUser}/>}
          </Typography>
        </SidebarHoverOver>
        {comment && <SunshineCommentsItemOverview comment={comment}/>}
        <SidebarInfo>
          {(post && !comment) && <>
            <strong>{ post?.title }</strong>
            <br/>
          </>}
          {reportedUser && <>
            <Link to={report.link}>
              <strong>{ reportedUser?.displayName }</strong>
              <PersonOutlineIcon className={classes.reportedUserIcon}/>
            </Link>
            <br/>
          </>}
          <em>"{ report.description }"</em> – {report.user && report.user.displayName}, <FormatDate date={report.createdAt}/>
        </SidebarInfo>
        {hover && <SidebarActionMenu>
          <SidebarAction title="Mark as Reviewed" onClick={handleReview}>
            <DoneIcon/>
          </SidebarAction>
          {(post || comment) && <SidebarAction title={`Spam${forumTypeSetting.get() === 'EAForum' ? '' : '/Eugin'} (delete immediately)`} onClick={handleDelete} warningHighlight>
            <DeleteIcon/>
          </SidebarAction>}
        </SidebarActionMenu>
        }
      </SunshineListItem>
    </span>
  );
}

const SunshineReportedItemComponent = registerComponent('SunshineReportedItem', SunshineReportedItem, {
  styles, hocs: [withErrorBoundary]
});

declare global {
  interface ComponentTypes {
    SunshineReportedItem: typeof SunshineReportedItemComponent
  }
}
