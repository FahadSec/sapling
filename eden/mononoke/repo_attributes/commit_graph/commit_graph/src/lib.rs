/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Commit Graph
//!
//! The graph of all commits in the repository.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use anyhow::anyhow;
use anyhow::Result;
use borrowed::borrowed;
use commit_graph_types::edges::ChangesetNode;
use commit_graph_types::edges::ChangesetParents;
use commit_graph_types::frontier::ChangesetFrontier;
use commit_graph_types::storage::CommitGraphStorage;
use commit_graph_types::storage::Prefetch;
use context::CoreContext;
use futures::future;
use futures::stream;
use futures::stream::BoxStream;
use futures::Future;
use futures::StreamExt;
use futures::TryStreamExt;
use mononoke_types::ChangesetId;
use mononoke_types::ChangesetIdPrefix;
use mononoke_types::ChangesetIdsResolvedFromPrefix;
use mononoke_types::Generation;

mod compat;
mod core;
mod frontier;

/// Commit Graph.
///
/// This contains the graph of all commits known to Mononoke for a particular
/// repository.  It provides methods for traversing the commit graph and
/// finding out graph-related information for the changesets contained
/// therein.
#[derive(Clone)]
#[facet::facet]
pub struct CommitGraph {
    /// The storage back-end where the commits are actually stored.
    storage: Arc<dyn CommitGraphStorage>,
}

impl CommitGraph {
    pub fn new(storage: Arc<dyn CommitGraphStorage>) -> CommitGraph {
        CommitGraph { storage }
    }

    /// Add a new changeset to the commit graph.
    ///
    /// Returns true if a new changeset was inserted, or false if the
    /// changeset already existed.
    pub async fn add(
        &self,
        ctx: &CoreContext,
        cs_id: ChangesetId,
        parents: ChangesetParents,
    ) -> Result<bool> {
        let parent_edges = self
            .storage
            .fetch_many_edges_required(ctx, &parents, Prefetch::None)
            .await?;

        self.storage
            .add(
                ctx,
                self.build_edges(ctx, cs_id, parents, &parent_edges).await?,
            )
            .await
    }

    /// Find all changeset ids with a given prefix.
    pub async fn find_by_prefix(
        &self,
        ctx: &CoreContext,
        cs_prefix: ChangesetIdPrefix,
        limit: usize,
    ) -> Result<ChangesetIdsResolvedFromPrefix> {
        self.storage.find_by_prefix(ctx, cs_prefix, limit).await
    }

    /// Returns true if the changeset exists.
    pub async fn exists(&self, ctx: &CoreContext, cs_id: ChangesetId) -> Result<bool> {
        let edges = self.storage.fetch_edges(ctx, cs_id).await?;
        Ok(edges.is_some())
    }

    /// Returns the parents of a single changeset.
    pub async fn changeset_parents(
        &self,
        ctx: &CoreContext,
        cs_id: ChangesetId,
    ) -> Result<Option<ChangesetParents>> {
        let edges = self.storage.fetch_edges(ctx, cs_id).await?;
        Ok(edges.map(|edges| {
            edges
                .parents
                .into_iter()
                .map(|parent| parent.cs_id)
                .collect()
        }))
    }

    /// Returns the parents of a single changeset that must exist.
    pub async fn changeset_parents_required(
        &self,
        ctx: &CoreContext,
        cs_id: ChangesetId,
    ) -> Result<ChangesetParents> {
        self.changeset_parents(ctx, cs_id)
            .await?
            .ok_or_else(|| anyhow!("Missing changeset in commit graph: {}", cs_id))
    }

    /// Returns the generation number of a single changeset.
    pub async fn changeset_generation(
        &self,
        ctx: &CoreContext,
        cs_id: ChangesetId,
    ) -> Result<Option<Generation>> {
        let edges = self.storage.fetch_edges(ctx, cs_id).await?;
        Ok(edges.map(|edges| edges.node.generation))
    }

    /// Returns the generation number of a single changeset that must exist.
    pub async fn changeset_generation_required(
        &self,
        ctx: &CoreContext,
        cs_id: ChangesetId,
    ) -> Result<Generation> {
        self.changeset_generation(ctx, cs_id)
            .await?
            .ok_or_else(|| anyhow!("Missing changeset in commit graph: {}", cs_id))
    }

    /// Returns a frontier for the ancestors of heads
    /// that satisfy a given property.
    ///
    /// Note: The property needs to be monotonic i.e. if the
    /// property holds for one changeset then it has to hold
    /// for all its parents.
    pub async fn ancestors_frontier_with<MonotonicProperty, Out>(
        &self,
        ctx: &CoreContext,
        heads: Vec<ChangesetId>,
        monotonic_property: MonotonicProperty,
    ) -> Result<Vec<ChangesetId>>
    where
        MonotonicProperty: Fn(ChangesetId) -> Out + Send + Sync + 'static,
        Out: Future<Output = Result<bool>>,
    {
        let mut ancestors_frontier = vec![];
        let mut frontier = self.frontier(ctx, heads).await?;

        let monotonic_property = move |node: ChangesetNode| {
            borrowed!(monotonic_property);
            monotonic_property(node.cs_id)
        };

        while let Some(ancestors_frontier_extension) = self
            .lower_frontier_step(ctx, &mut frontier, &monotonic_property, Prefetch::None)
            .await?
        {
            ancestors_frontier.extend(ancestors_frontier_extension);
        }

        Ok(ancestors_frontier.into_iter().collect())
    }

    /// Returns true if the ancestor changeset is an ancestor of the descendant
    /// changeset.
    ///
    /// Ancestry is inclusive: a commit is its own ancestor.
    pub async fn is_ancestor(
        &self,
        ctx: &CoreContext,
        ancestor: ChangesetId,
        descendant: ChangesetId,
    ) -> Result<bool> {
        let (mut frontier, target_gen) = futures::try_join!(
            self.single_frontier(ctx, descendant),
            self.changeset_generation_required(ctx, ancestor)
        )?;
        debug_assert!(!frontier.is_empty(), "frontier should contain descendant");
        self.lower_frontier(ctx, &mut frontier, target_gen).await?;
        Ok(frontier.highest_generation_contains(ancestor, target_gen))
    }

    pub async fn ancestors_difference_stream_with<MonotonicProperty, Out>(
        &self,
        ctx: &CoreContext,
        heads: Vec<ChangesetId>,
        common: Vec<ChangesetId>,
        monotonic_property: MonotonicProperty,
    ) -> Result<BoxStream<'static, Result<ChangesetId>>>
    where
        MonotonicProperty: Fn(ChangesetId) -> Out + Send + Sync + 'static,
        Out: Future<Output = Result<bool>> + Send,
    {
        struct AncestorsDifferenceState<P> {
            commit_graph: CommitGraph,
            ctx: CoreContext,
            heads: ChangesetFrontier,
            common: ChangesetFrontier,
            monotonic_property: P,
        }

        let (heads, common) =
            futures::try_join!(self.frontier(ctx, heads), self.frontier(ctx, common))?;

        Ok(stream::try_unfold(
            Box::new(AncestorsDifferenceState {
                commit_graph: self.clone(),
                ctx: ctx.clone(),
                heads,
                common,
                monotonic_property,
            }),
            move |mut state| async move {
                let AncestorsDifferenceState {
                    commit_graph,
                    ctx,
                    heads,
                    common,
                    monotonic_property,
                } = &mut *state;

                if let Some((generation, cs_ids)) = heads.pop_last() {
                    commit_graph.lower_frontier(ctx, common, generation).await?;

                    let mut cs_ids_not_excluded = vec![];
                    for cs_id in cs_ids {
                        if !common.highest_generation_contains(cs_id, generation)
                            && !monotonic_property(cs_id).await?
                        {
                            cs_ids_not_excluded.push(cs_id)
                        }
                    }

                    let all_edges = commit_graph
                        .storage
                        .fetch_many_edges(
                            ctx,
                            &cs_ids_not_excluded,
                            Prefetch::for_p1_linear_traversal(),
                        )
                        .await?;

                    for (_, edges) in all_edges.into_iter() {
                        for parent in edges.parents.into_iter() {
                            heads
                                .entry(parent.generation)
                                .or_default()
                                .insert(parent.cs_id);
                        }
                    }

                    anyhow::Ok(Some((stream::iter(cs_ids_not_excluded).map(Ok), state)))
                } else {
                    Ok(None)
                }
            },
        )
        .try_flatten()
        .boxed())
    }

    pub async fn ancestors_difference_stream(
        &self,
        ctx: &CoreContext,
        heads: Vec<ChangesetId>,
        common: Vec<ChangesetId>,
    ) -> Result<BoxStream<'static, Result<ChangesetId>>> {
        self.ancestors_difference_stream_with(ctx, heads, common, |_| future::ready(Ok(false)))
            .await
    }

    /// Returns all ancestors of any changeset in heads, excluding
    /// any ancestor of any changeset in common and any changeset
    /// that satisfies a given property.
    ///
    /// Note: The property needs to be monotonic i.e. if the
    /// property holds for one changeset then it has to hold
    /// for all its parents.
    pub async fn ancestors_difference_with<MonotonicProperty, Out>(
        &self,
        ctx: &CoreContext,
        heads: Vec<ChangesetId>,
        common: Vec<ChangesetId>,
        monotonic_property: MonotonicProperty,
    ) -> Result<Vec<ChangesetId>>
    where
        MonotonicProperty: Fn(ChangesetId) -> Out + Send + Sync + 'static,
        Out: Future<Output = Result<bool>> + Send,
    {
        self.ancestors_difference_stream_with(ctx, heads, common, monotonic_property)
            .await?
            .try_collect()
            .await
    }

    /// Returns all ancestors of any changeset in heads, excluding
    /// any ancestor of any changeset in common.
    pub async fn ancestors_difference(
        &self,
        ctx: &CoreContext,
        heads: Vec<ChangesetId>,
        common: Vec<ChangesetId>,
    ) -> Result<Vec<ChangesetId>> {
        self.ancestors_difference_stream(ctx, heads, common)
            .await?
            .try_collect()
            .await
    }

    pub async fn range_stream(
        &self,
        ctx: &CoreContext,
        start_id: ChangesetId,
        end_id: ChangesetId,
    ) -> Result<BoxStream<'static, ChangesetId>> {
        let (start_generation, mut frontier) = futures::try_join!(
            self.changeset_generation_required(ctx, start_id),
            self.single_frontier(ctx, end_id)
        )?;
        let mut children: HashMap<ChangesetId, HashSet<(ChangesetId, Generation)>> =
            Default::default();
        let mut reached_start = false;

        while let Some((gen, cs_ids)) = frontier.pop_last() {
            let cs_ids = cs_ids.into_iter().collect::<Vec<_>>();
            let all_edges = self
                .storage
                .fetch_many_edges_required(ctx, &cs_ids, Prefetch::for_p1_linear_traversal())
                .await?;

            reached_start |= cs_ids.contains(&start_id);

            if gen > start_generation {
                for (_, edges) in all_edges.into_iter() {
                    for parent in edges.parents.into_iter() {
                        children
                            .entry(parent.cs_id)
                            .or_default()
                            .insert((edges.node.cs_id, edges.node.generation));
                        frontier
                            .entry(parent.generation)
                            .or_default()
                            .insert(parent.cs_id);
                    }
                }
            }
        }

        if !reached_start {
            return Ok(stream::empty().boxed());
        }

        struct RangeStreamState {
            children: HashMap<ChangesetId, HashSet<(ChangesetId, Generation)>>,
            upwards_frontier: ChangesetFrontier,
        }

        Ok(stream::unfold(
            Box::new(RangeStreamState {
                children,
                upwards_frontier: ChangesetFrontier::new_single(start_id, start_generation),
            }),
            |mut state| async {
                if let Some((_, cs_ids)) = state.upwards_frontier.pop_first() {
                    for cs_id in cs_ids.iter() {
                        if let Some(children) = state.children.get(cs_id) {
                            for (child, generation) in children.iter() {
                                state
                                    .upwards_frontier
                                    .entry(*generation)
                                    .or_default()
                                    .insert(*child);
                            }
                        }
                    }
                    Some((stream::iter(cs_ids), state))
                } else {
                    None
                }
            },
        )
        .flatten()
        .boxed())
    }

    /// Returns all of the highest generation changesets that
    /// are ancestors of both u and v, sorted by changeset id.
    pub async fn common_base(
        &self,
        ctx: &CoreContext,
        u: ChangesetId,
        v: ChangesetId,
    ) -> Result<Vec<ChangesetId>> {
        let (mut u_frontier, mut v_frontier) =
            futures::try_join!(self.single_frontier(ctx, u), self.single_frontier(ctx, v))?;

        loop {
            let u_gen = match u_frontier.last_key_value() {
                Some((gen, _)) => *gen,
                // if u_frontier is empty then there are no common ancestors.
                None => return Ok(vec![]),
            };

            // lower v_frontier to the highest generation of u_frontier
            self.lower_frontier(ctx, &mut v_frontier, u_gen).await?;

            // Check if the highest generation of u_frontier intersects with v_frontier
            // and return the intersection if so.
            let mut intersection = u_frontier.highest_generation_intersection(&v_frontier);
            if !intersection.is_empty() {
                intersection.sort();
                return Ok(intersection);
            }

            let u_highest_generation_edges = match u_frontier
                .last_key_value()
                .and_then(|(_, cs_ids)| cs_ids.iter().next())
            {
                Some(cs_id) => self.storage.fetch_edges_required(ctx, *cs_id).await?,
                None => return Ok(vec![]),
            };

            // Try to lower u_frontier to the generation of one of its
            // highest generation changesets' skip tree skew ancestor.
            // This is optimized for the case where u_frontier has only
            // one changeset, but is correct in all cases.
            if let Some(ancestor) = u_highest_generation_edges.skip_tree_skew_ancestor {
                let mut lowered_u_frontier = u_frontier.clone();
                let mut lowered_v_frontier = v_frontier.clone();

                self.lower_frontier(ctx, &mut lowered_u_frontier, ancestor.generation)
                    .await?;
                self.lower_frontier(ctx, &mut lowered_v_frontier, ancestor.generation)
                    .await?;

                // If the two lowered frontier are disjoint then it's safe to lower,
                // otherwise there might be a higher generation common ancestor.
                if lowered_u_frontier.is_disjoint(&lowered_v_frontier) {
                    u_frontier = lowered_u_frontier;
                    v_frontier = lowered_v_frontier;

                    continue;
                }
            }

            // If we could lower u_frontier using the skip tree skew ancestor
            // lower only the highest generation instead.
            self.lower_frontier_highest_generation(ctx, &mut u_frontier)
                .await?;
        }
    }

    /// Slices ancestors of heads into a sequence of slices for processing.
    ///
    /// Each slice contains a frontier of changesets within a generation range, returning
    /// (slice_start, slice_frontier) corresponds to the frontier that has generations numbers
    /// within [slice_start..(slice_start + slice_size)].
    ///
    /// Useful for any type of processing that needs to happen on ancestors of changesets first.
    /// By processing slices one by one we avoid traversing the entire history all at once.
    ///
    /// The returned slices consist only of frontiers which haven't been processed yet
    /// (determined by the provided needs_processing function). Slicing stops once we
    /// reach a frontier with all its changesets processed.
    pub async fn slice_ancestors<NeedsProcessing, Out>(
        &self,
        ctx: &CoreContext,
        heads: Vec<ChangesetId>,
        needs_processing: NeedsProcessing,
        slice_size: u64,
    ) -> Result<Vec<(u64, Vec<ChangesetId>)>>
    where
        NeedsProcessing: Fn(Vec<ChangesetId>) -> Out,
        Out: Future<Output = Result<HashSet<ChangesetId>>>,
    {
        let mut frontier = self.frontier(ctx, heads).await?;

        let max_gen = match frontier.last_key_value() {
            Some((gen, _)) => gen,
            None => return Ok(vec![]),
        };

        // The start of the slice is largest number in the sequence
        // 1, slice_size + 1, 2 * slice_size + 1 ...
        let mut slice_start = ((max_gen.value() - 1) / slice_size) * slice_size + 1;

        let mut slices = vec![];

        // Loop over slices in decreasing order of start generation.
        loop {
            let needed_cs_ids = needs_processing(frontier.changesets()).await?;
            frontier = frontier
                .into_flat_iter()
                .filter(|(cs_id, _)| needed_cs_ids.contains(cs_id))
                .collect();

            if frontier.is_empty() {
                break;
            }

            // Only push changesets that are in this slice's range.
            // Any remaining changesets will be pushed in the next iterations.
            slices.push((
                slice_start,
                frontier.changesets_in_range(
                    Generation::new(slice_start)..Generation::new(slice_start + slice_size),
                ),
            ));

            if slice_start > 1 {
                // Lower the frontier to the end of the next slice (current slice_start - 1).
                self.lower_frontier(ctx, &mut frontier, Generation::new(slice_start - 1))
                    .await?;
                slice_start -= slice_size;
            } else {
                break;
            }
        }

        Ok(slices.into_iter().rev().collect())
    }

    /// Returns the children of a single changeset.
    pub async fn changeset_children(
        &self,
        ctx: &CoreContext,
        cs_id: ChangesetId,
    ) -> Result<Vec<ChangesetId>> {
        self.storage.fetch_children(ctx, cs_id).await
    }
}
